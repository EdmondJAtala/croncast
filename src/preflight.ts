import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { AppConfig } from './config.js';

export interface PreflightResult {
  name: string;
  status: 'pass' | 'warn' | 'fail';
  message: string;
  detail?: string;
}

let preflightResults: PreflightResult[] = [];

export function getPreflightResults(): PreflightResult[] {
  return preflightResults;
}

function runCommand(command: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const proc = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    proc.on('error', () => {
      resolve({ code: -1, stdout, stderr });
    });
    proc.on('close', (code) => {
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

async function checkFfmpeg(): Promise<PreflightResult> {
  const result = await runCommand('ffmpeg', ['-version']);
  if (result.code === 0) {
    const version = result.stdout.split('\n')[0] ?? 'unknown';
    return { name: 'ffmpeg', status: 'pass', message: `ffmpeg found: ${version.trim()}` };
  }
  return {
    name: 'ffmpeg',
    status: 'fail',
    message: 'ffmpeg not found on PATH. Install ffmpeg to use croncast.',
  };
}

async function checkExecutablePath(config: AppConfig): Promise<PreflightResult | null> {
  if (!config.executablePath) return null;

  try {
    await fs.access(config.executablePath, fs.constants.X_OK);
    return { name: 'Chrome executable', status: 'pass', message: `Found: ${config.executablePath}` };
  } catch {
    return {
      name: 'Chrome executable',
      status: 'fail',
      message: `Chrome executable not found at ${config.executablePath}.`,
    };
  }
}

async function isWSL(): Promise<boolean> {
  try {
    const content = await fs.readFile('/proc/version', 'utf-8');
    return /microsoft/i.test(content);
  } catch {
    return false;
  }
}

async function checkWindowsSleep(): Promise<PreflightResult[]> {
  const results: PreflightResult[] = [];

  const checks = [
    { name: 'Windows sleep timeout', subKey: 'STANDBYIDLE', fixArg: 'standby-timeout-ac' },
    { name: 'Windows hibernate timeout', subKey: 'HIBERNATEIDLE', fixArg: 'hibernate-timeout-ac' },
  ];

  for (const check of checks) {
    const result = await runCommand('powershell.exe', [
      '-Command',
      `powercfg /query SCHEME_CURRENT SUB_SLEEP ${check.subKey}`,
    ]);

    if (result.code !== 0) {
      results.push({
        name: check.name,
        status: 'warn',
        message: `Could not query ${check.name.toLowerCase()} setting.`,
      });
      continue;
    }

    const hexMatch = result.stdout.match(/Current AC Power Setting Index:\s*0x([0-9a-fA-F]+)/);
    if (hexMatch) {
      const value = parseInt(hexMatch[1], 16);
      if (value !== 0) {
        const minutes = Math.round(value / 60);
        results.push({
          name: check.name,
          status: 'warn',
          message: `Windows is configured to ${check.subKey === 'STANDBYIDLE' ? 'sleep' : 'hibernate'} after ${minutes} minutes. This will interrupt recordings.`,
          detail: `Run: powershell.exe -Command "powercfg /change ${check.fixArg} 0" to disable.`,
        });
      } else {
        results.push({
          name: check.name,
          status: 'pass',
          message: `${check.name} is disabled.`,
        });
      }
    }
  }

  return results;
}

async function checkWSLIdleTimeout(): Promise<PreflightResult> {
  try {
    const result = await runCommand('powershell.exe', [
      '-Command',
      'Get-Content "$env:USERPROFILE\\.wslconfig" 2>$null',
    ]);

    if (result.code === 0 && result.stdout.trim().length > 0) {
      const match = result.stdout.match(/vmIdleTimeout\s*=\s*(-?\d+)/i);
      if (match) {
        const value = parseInt(match[1], 10);
        if (value === -1) {
          return { name: 'WSL idle timeout', status: 'pass', message: 'vmIdleTimeout is disabled (-1).' };
        }
        return {
          name: 'WSL idle timeout',
          status: 'warn',
          message: `WSL vmIdleTimeout is set to ${value}ms. This may shut down WSL during idle periods.`,
          detail: 'Set vmIdleTimeout=-1 in .wslconfig to disable.',
        };
      }
    }

    return {
      name: 'WSL idle timeout',
      status: 'warn',
      message: 'Could not confirm WSL vmIdleTimeout is disabled.',
      detail: 'If recordings are interrupted, add vmIdleTimeout=-1 to your .wslconfig.',
    };
  } catch {
    return {
      name: 'WSL idle timeout',
      status: 'warn',
      message: 'Could not check WSL idle timeout.',
      detail: 'If recordings are interrupted, add vmIdleTimeout=-1 to your .wslconfig.',
    };
  }
}

async function checkWindowsAutoUpdate(): Promise<PreflightResult> {
  // Check if auto-restart with logged-on users is disabled via group policy
  const rebootResult = await runCommand('powershell.exe', [
    '-Command',
    `Get-ItemProperty -Path 'HKLM:\\SOFTWARE\\Policies\\Microsoft\\Windows\\WindowsUpdate\\AU' -Name NoAutoRebootWithLoggedOnUsers -ErrorAction Stop | Select-Object -ExpandProperty NoAutoRebootWithLoggedOnUsers`,
  ]);

  if (rebootResult.code === 0 && parseInt(rebootResult.stdout.trim(), 10) === 1) {
    return {
      name: 'Windows auto-update restart',
      status: 'pass',
      message: 'Auto-restart with logged-on users is disabled.',
    };
  }

  // Check if updates are paused
  const pauseResult = await runCommand('powershell.exe', [
    '-Command',
    `Get-ItemProperty -Path 'HKLM:\\SOFTWARE\\Microsoft\\WindowsUpdate\\UX\\Settings' -Name PauseUpdatesExpiryTime -ErrorAction Stop | Select-Object -ExpandProperty PauseUpdatesExpiryTime`,
  ]);

  if (pauseResult.code === 0) {
    const expiryStr = pauseResult.stdout.trim();
    const expiry = new Date(expiryStr);
    if (expiry.getTime() > Date.now()) {
      return {
        name: 'Windows auto-update restart',
        status: 'pass',
        message: `Updates are paused until ${expiry.toLocaleDateString()}.`,
      };
    }
  }

  return {
    name: 'Windows auto-update restart',
    status: 'warn',
    message: 'Windows may auto-restart for updates during a recording.',
    detail: 'Pause updates in Settings > Windows Update, or run: reg add "HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows\\WindowsUpdate\\AU" /v NoAutoRebootWithLoggedOnUsers /t REG_DWORD /d 1 /f',
  };
}

async function checkDiskSpace(config: AppConfig): Promise<PreflightResult> {
  try {
    const path = await import('node:path');
    let target = path.resolve(config.outputDir);

    // Walk up to an existing directory
    try {
      await fs.access(target);
    } catch {
      target = path.dirname(target);
    }

    const stats = await fs.statfs(target);
    const availBytes = stats.bfree * stats.bsize;
    const availGB = availBytes / (1024 * 1024 * 1024);

    // Find longest job
    let longestJob = config.jobs[0];
    for (const job of config.jobs) {
      if (job.durationSeconds > longestJob.durationSeconds) {
        longestJob = job;
      }
    }

    const estimateGB = (longestJob.durationSeconds / 3600) * 0.1; // ~100MB/hour
    const needed = estimateGB * 2;

    if (availGB < needed) {
      return {
        name: 'Disk space',
        status: 'warn',
        message: `Low disk space: ${availGB.toFixed(1)} GB free. Longest job ("${longestJob.name}", ${(longestJob.durationSeconds / 3600).toFixed(1)}h) may need ~${estimateGB.toFixed(1)} GB.`,
      };
    }

    return {
      name: 'Disk space',
      status: 'pass',
      message: `${availGB.toFixed(1)} GB free.`,
    };
  } catch {
    return { name: 'Disk space', status: 'warn', message: 'Could not check disk space.' };
  }
}

export async function runPreflightChecks(config: AppConfig): Promise<PreflightResult[]> {
  const results: PreflightResult[] = [];

  results.push(await checkFfmpeg());

  const execResult = await checkExecutablePath(config);
  if (execResult) results.push(execResult);

  if (await isWSL()) {
    const sleepResults = await checkWindowsSleep();
    results.push(...sleepResults);
    results.push(await checkWSLIdleTimeout());
  } else if (process.platform === 'win32') {
    const sleepResults = await checkWindowsSleep();
    results.push(...sleepResults);
    results.push(await checkWindowsAutoUpdate());
  }

  results.push(await checkDiskSpace(config));

  preflightResults = results;
  return results;
}
