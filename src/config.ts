import fs from 'node:fs/promises';
import { ConfigError } from './errors.js';

export interface JobConfig {
  id?: string;
  name: string;
  url?: string;
  urlPattern?: string;
  schedule?: string;
  enabled?: boolean;
  durationSeconds: number;
  captureFps?: number;
  viewportWidth?: number;
  viewportHeight?: number;
}

export interface AppConfig {
  browserURL?: string;
  executablePath?: string;
  headless?: boolean;
  chromePath?: string;
  autoLaunchChrome?: boolean;
  outputDir: string;
  port?: number;
  dismissedChecks?: string[];
  minimizeToTray?: boolean;
  jobs: JobConfig[];
}

let configPath = 'config.json';

export function getConfigPath(): string {
  return configPath;
}

export function setConfigPath(p: string): void {
  configPath = p;
}

export function validateConfig(raw: unknown): AppConfig {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ConfigError('Config must be a JSON object');
  }

  const obj = raw as Record<string, unknown>;

  if (obj.browserURL !== undefined && obj.executablePath !== undefined) {
    throw new ConfigError('Config must not specify both browserURL and executablePath');
  }

  if (obj.browserURL !== undefined && typeof obj.browserURL !== 'string') {
    throw new ConfigError('browserURL must be a string');
  }

  if (obj.executablePath !== undefined && typeof obj.executablePath !== 'string') {
    throw new ConfigError('executablePath must be a string');
  }

  if (obj.chromePath !== undefined && typeof obj.chromePath !== 'string') {
    throw new ConfigError('chromePath must be a string');
  }

  if (obj.headless !== undefined && typeof obj.headless !== 'boolean') {
    throw new ConfigError('headless must be a boolean');
  }

  if (obj.outputDir !== undefined && typeof obj.outputDir !== 'string') {
    throw new ConfigError('outputDir must be a string');
  }

  if (!Array.isArray(obj.jobs) || obj.jobs.length === 0) {
    throw new ConfigError('jobs must be a non-empty array');
  }

  for (const job of obj.jobs) {
    if (typeof job !== 'object' || job === null) {
      throw new ConfigError('Each job must be an object');
    }
    const j = job as Record<string, unknown>;

    if (typeof j.name !== 'string' || j.name.length === 0) {
      throw new ConfigError('Each job must have a non-empty name');
    }

    if (j.schedule !== undefined && (typeof j.schedule !== 'string' || j.schedule.length === 0)) {
      throw new ConfigError(`Job "${j.name}": schedule must be a non-empty string if provided`);
    }

    if (typeof j.durationSeconds !== 'number' || j.durationSeconds <= 0) {
      throw new ConfigError(`Job "${j.name}": durationSeconds must be a positive number`);
    }

    if (j.url === undefined && j.urlPattern === undefined) {
      throw new ConfigError(`Job "${j.name}": must have at least one of url or urlPattern`);
    }

    if (j.url !== undefined && typeof j.url !== 'string') {
      throw new ConfigError(`Job "${j.name}": url must be a string`);
    }

    if (j.urlPattern !== undefined && typeof j.urlPattern !== 'string') {
      throw new ConfigError(`Job "${j.name}": urlPattern must be a string`);
    }

    if (j.enabled !== undefined && typeof j.enabled !== 'boolean') {
      throw new ConfigError(`Job "${j.name}": enabled must be a boolean`);
    }

    if (j.captureFps !== undefined) {
      if (typeof j.captureFps !== 'number' || j.captureFps < 1 || j.captureFps > 30) {
        throw new ConfigError(`Job "${j.name}": captureFps must be a number between 1 and 30`);
      }
    }

    if (j.viewportWidth !== undefined) {
      if (typeof j.viewportWidth !== 'number' || !Number.isInteger(j.viewportWidth) || j.viewportWidth <= 0) {
        throw new ConfigError(`Job "${j.name}": viewportWidth must be a positive integer`);
      }
    }

    if (j.viewportHeight !== undefined) {
      if (typeof j.viewportHeight !== 'number' || !Number.isInteger(j.viewportHeight) || j.viewportHeight <= 0) {
        throw new ConfigError(`Job "${j.name}": viewportHeight must be a positive integer`);
      }
    }
  }

  const config: AppConfig = {
    outputDir: typeof obj.outputDir === 'string' ? obj.outputDir : './recordings',
    jobs: (obj.jobs as Record<string, unknown>[]).map(j => ({
      id: typeof j.id === 'string' && j.id.length > 0 ? j.id : Math.random().toString(36).slice(2, 10),
      name: j.name as string,
      url: j.url as string | undefined,
      urlPattern: j.urlPattern as string | undefined,
      schedule: j.schedule as string | undefined,
      enabled: j.enabled !== false,
      durationSeconds: j.durationSeconds as number,
      captureFps: j.captureFps as number | undefined,
      viewportWidth: j.viewportWidth as number | undefined,
      viewportHeight: j.viewportHeight as number | undefined,
    })),
  };

  if (obj.chromePath) {
    config.chromePath = obj.chromePath as string;
  }

  if (typeof obj.autoLaunchChrome === 'boolean') {
    config.autoLaunchChrome = obj.autoLaunchChrome;
  }

  if (Array.isArray(obj.dismissedChecks)) {
    config.dismissedChecks = (obj.dismissedChecks as unknown[]).filter(
      (v): v is string => typeof v === 'string'
    );
  }

  if (typeof obj.minimizeToTray === 'boolean') {
    config.minimizeToTray = obj.minimizeToTray;
  }

  if (obj.executablePath !== undefined) {
    config.executablePath = obj.executablePath as string;
    if (obj.headless !== undefined) {
      config.headless = obj.headless as boolean;
    }
  } else {
    config.browserURL = typeof obj.browserURL === 'string'
      ? obj.browserURL
      : 'http://localhost:9222';
  }

  return config;
}

export async function loadConfig(filePath: string): Promise<AppConfig> {
  const text = await fs.readFile(filePath, 'utf-8');
  const raw = JSON.parse(text);
  return validateConfig(raw);
}

export async function saveConfig(filePath: string, config: AppConfig): Promise<void> {
  validateConfig(config);
  await fs.writeFile(filePath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
}
