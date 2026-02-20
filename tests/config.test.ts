import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { validateConfig, loadConfig, saveConfig } from '../src/config.js';
import { ConfigError } from '../src/errors.js';

// Helper: minimal valid connect-mode config
function connectConfig(overrides: Record<string, unknown> = {}) {
  return {
    browserURL: 'http://localhost:9222',
    jobs: [
      { name: 'test-job', url: 'https://example.com', schedule: '* * * * *', durationSeconds: 10 },
    ],
    ...overrides,
  };
}

// Helper: minimal valid launch-mode config
function launchConfig(overrides: Record<string, unknown> = {}) {
  return {
    executablePath: '/usr/bin/google-chrome',
    jobs: [
      { name: 'test-job', url: 'https://example.com', schedule: '* * * * *', durationSeconds: 10 },
    ],
    ...overrides,
  };
}

describe('validateConfig', () => {
  it('accepts a valid connect-mode config', () => {
    const config = validateConfig(connectConfig());
    assert.equal(config.browserURL, 'http://localhost:9222');
    assert.equal(config.jobs.length, 1);
  });

  it('accepts a valid launch-mode config', () => {
    const config = validateConfig(launchConfig());
    assert.equal(config.executablePath, '/usr/bin/google-chrome');
    assert.equal(config.browserURL, undefined);
  });

  it('rejects config with both browserURL and executablePath', () => {
    assert.throws(
      () => validateConfig({ browserURL: 'http://localhost:9222', executablePath: '/usr/bin/chrome', jobs: [{ name: 'j', url: 'http://x', schedule: '* * * * *', durationSeconds: 1 }] }),
      ConfigError,
    );
  });

  it('rejects null', () => {
    assert.throws(() => validateConfig(null), ConfigError);
  });

  it('rejects an array', () => {
    assert.throws(() => validateConfig([1, 2, 3]), ConfigError);
  });

  it('rejects a string', () => {
    assert.throws(() => validateConfig('hello'), ConfigError);
  });

  it('rejects missing jobs array', () => {
    assert.throws(() => validateConfig({ browserURL: 'http://localhost:9222' }), ConfigError);
  });

  it('rejects empty jobs array', () => {
    assert.throws(() => validateConfig(connectConfig({ jobs: [] })), ConfigError);
  });

  it('rejects job missing name', () => {
    assert.throws(
      () => validateConfig(connectConfig({ jobs: [{ url: 'http://x', schedule: '* * * * *', durationSeconds: 1 }] })),
      ConfigError,
    );
  });

  it('accepts job without schedule (manual only)', () => {
    const config = validateConfig(connectConfig({ jobs: [{ name: 'j', url: 'http://x', durationSeconds: 1 }] }));
    assert.equal(config.jobs[0].schedule, undefined);
  });

  it('rejects job with empty schedule string', () => {
    assert.throws(
      () => validateConfig(connectConfig({ jobs: [{ name: 'j', url: 'http://x', schedule: '', durationSeconds: 1 }] })),
      ConfigError,
    );
  });

  it('rejects job missing durationSeconds', () => {
    assert.throws(
      () => validateConfig(connectConfig({ jobs: [{ name: 'j', url: 'http://x', schedule: '* * * * *' }] })),
      ConfigError,
    );
  });

  it('rejects job missing both url and urlPattern', () => {
    assert.throws(
      () => validateConfig(connectConfig({ jobs: [{ name: 'j', schedule: '* * * * *', durationSeconds: 1 }] })),
      ConfigError,
    );
  });

  it('validates captureFps range (1-30)', () => {
    // Valid
    const config = validateConfig(connectConfig({
      jobs: [{ name: 'j', url: 'http://x', schedule: '* * * * *', durationSeconds: 1, captureFps: 15 }],
    }));
    assert.equal(config.jobs[0].captureFps, 15);

    // Too low
    assert.throws(
      () => validateConfig(connectConfig({
        jobs: [{ name: 'j', url: 'http://x', schedule: '* * * * *', durationSeconds: 1, captureFps: 0 }],
      })),
      ConfigError,
    );

    // Too high
    assert.throws(
      () => validateConfig(connectConfig({
        jobs: [{ name: 'j', url: 'http://x', schedule: '* * * * *', durationSeconds: 1, captureFps: 31 }],
      })),
      ConfigError,
    );
  });

  it('validates viewportWidth and viewportHeight types', () => {
    // Valid
    const config = validateConfig(connectConfig({
      jobs: [{ name: 'j', url: 'http://x', schedule: '* * * * *', durationSeconds: 1, viewportWidth: 1920, viewportHeight: 1080 }],
    }));
    assert.equal(config.jobs[0].viewportWidth, 1920);
    assert.equal(config.jobs[0].viewportHeight, 1080);

    // Non-integer
    assert.throws(
      () => validateConfig(connectConfig({
        jobs: [{ name: 'j', url: 'http://x', schedule: '* * * * *', durationSeconds: 1, viewportWidth: 19.5 }],
      })),
      ConfigError,
    );

    // Negative
    assert.throws(
      () => validateConfig(connectConfig({
        jobs: [{ name: 'j', url: 'http://x', schedule: '* * * * *', durationSeconds: 1, viewportHeight: -100 }],
      })),
      ConfigError,
    );
  });

  it('applies default outputDir', () => {
    const config = validateConfig(connectConfig());
    assert.equal(config.outputDir, './recordings');
  });

  it('applies default port', () => {
    const config = validateConfig(connectConfig());
    assert.equal(config.port, 3000);
  });

  it('applies default browserURL when neither browserURL nor executablePath is set', () => {
    const config = validateConfig({
      jobs: [{ name: 'j', url: 'http://x', schedule: '* * * * *', durationSeconds: 1 }],
    });
    assert.equal(config.browserURL, 'http://localhost:9222');
  });

  it('auto-generates job IDs when missing', () => {
    const config = validateConfig(connectConfig());
    assert.ok(config.jobs[0].id);
    assert.ok(config.jobs[0].id!.length > 0);
  });

  it('preserves existing job IDs', () => {
    const config = validateConfig(connectConfig({
      jobs: [{ id: 'my-id', name: 'j', url: 'http://x', schedule: '* * * * *', durationSeconds: 1 }],
    }));
    assert.equal(config.jobs[0].id, 'my-id');
  });
});

describe('loadConfig', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'croncast-test-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('reads and validates a config file', async () => {
    const filePath = path.join(tmpDir, 'config.json');
    await fs.writeFile(filePath, JSON.stringify(connectConfig()));
    const config = await loadConfig(filePath);
    assert.equal(config.browserURL, 'http://localhost:9222');
    assert.equal(config.jobs.length, 1);
  });

  it('throws on invalid JSON', async () => {
    const filePath = path.join(tmpDir, 'bad.json');
    await fs.writeFile(filePath, '{ not valid json }');
    await assert.rejects(() => loadConfig(filePath), SyntaxError);
  });

  it('throws on invalid config shape', async () => {
    const filePath = path.join(tmpDir, 'empty.json');
    await fs.writeFile(filePath, JSON.stringify({ noJobs: true }));
    await assert.rejects(() => loadConfig(filePath), ConfigError);
  });
});

describe('saveConfig', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'croncast-test-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('writes valid JSON and re-validates', async () => {
    const filePath = path.join(tmpDir, 'config.json');
    const config = validateConfig(connectConfig());
    await saveConfig(filePath, config);

    const written = JSON.parse(await fs.readFile(filePath, 'utf-8'));
    assert.equal(written.browserURL, 'http://localhost:9222');
    assert.equal(written.jobs.length, 1);
  });

  it('rejects saving invalid config', async () => {
    const filePath = path.join(tmpDir, 'config.json');
    await assert.rejects(
      () => saveConfig(filePath, { jobs: [] } as any),
      ConfigError,
    );
  });
});
