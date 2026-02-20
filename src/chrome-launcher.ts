import { spawn, execSync, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';

let chromeProcess: ChildProcess | null = null;
let chromePort: number | null = null;

export function parsePortFromURL(browserURL: string): number {
  try {
    const url = new URL(browserURL);
    return parseInt(url.port, 10) || 9222;
  } catch {
    return 9222;
  }
}

export function launchDebugChrome(chromePath: string, port: number): void {
  if (chromeProcess) {
    throw new Error('Debug Chrome is already running');
  }

  const userDataDir = path.join(os.tmpdir(), 'croncast-chrome-debug');

  const args = [
    `--remote-debugging-port=${port}`,
    `--remote-allow-origins=http://localhost:${port},http://127.0.0.1:${port}`,
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
  ];

  chromeProcess = spawn(chromePath, args, {
    detached: true,
    stdio: 'ignore',
  });

  chromePort = port;

  chromeProcess.on('error', () => {
    chromeProcess = null;
    chromePort = null;
  });

  chromeProcess.on('exit', () => {
    chromeProcess = null;
    chromePort = null;
  });

  chromeProcess.unref();
}

export function stopDebugChrome(): void {
  if (!chromeProcess || chromeProcess.pid === undefined) {
    chromeProcess = null;
    chromePort = null;
    return;
  }

  try {
    if (process.platform === 'win32') {
      execSync(`taskkill /pid ${chromeProcess.pid} /T /F`, { stdio: 'ignore' });
    } else {
      chromeProcess.kill('SIGTERM');
    }
  } catch {
    // Process may already be dead
  }

  chromeProcess = null;
  chromePort = null;
}

export function getDebugChromeStatus(): { running: boolean; pid?: number; port?: number } {
  if (chromeProcess && chromeProcess.pid !== undefined) {
    return { running: true, pid: chromeProcess.pid, port: chromePort ?? undefined };
  }
  return { running: false };
}
