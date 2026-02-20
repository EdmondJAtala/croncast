import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import request from 'supertest';
import { validateConfig, type AppConfig } from '../src/config.js';
import { createServer } from '../src/server.js';
import { startScheduler, stopScheduler } from '../src/scheduler.js';

function makeConfig(overrides: Record<string, unknown> = {}): AppConfig {
  return validateConfig({
    browserURL: 'http://localhost:9222',
    jobs: [
      { id: 'job1', name: 'test-job', url: 'https://example.com', durationSeconds: 10 },
    ],
    ...overrides,
  });
}

describe('API server', () => {
  let tmpDir: string;
  let config: AppConfig;
  let configPath: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'croncast-server-test-'));
    configPath = path.join(tmpDir, 'config.json');
    config = makeConfig({ outputDir: tmpDir });
    await fs.writeFile(configPath, JSON.stringify(config));
    startScheduler(config);
  });

  afterEach(async () => {
    stopScheduler();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe('GET /api/status', () => {
    it('returns status with uptime, mode, and timezone', async () => {
      const app = createServer(config, configPath);
      const res = await request(app).get('/api/status');
      assert.equal(res.status, 200);
      assert.equal(res.body.mode, 'connect');
      assert.equal(typeof res.body.uptime, 'number');
      assert.equal(typeof res.body.timezone, 'string');
    });
  });

  describe('GET /api/config', () => {
    it('returns current config', async () => {
      const app = createServer(config, configPath);
      const res = await request(app).get('/api/config');
      assert.equal(res.status, 200);
      assert.equal(res.body.browserURL, 'http://localhost:9222');
      assert.ok(Array.isArray(res.body.jobs));
    });
  });

  describe('PUT /api/config', () => {
    it('rejects invalid config', async () => {
      const app = createServer(config, configPath);
      const res = await request(app)
        .put('/api/config')
        .set('Content-Type', 'application/json')
        .send({ jobs: [] });
      assert.equal(res.status, 400);
    });

    it('accepts valid config update', async () => {
      const app = createServer(config, configPath);
      const updated = {
        ...config,
        jobs: [{ id: 'job1', name: 'updated-job', url: 'https://example.com', durationSeconds: 30 }],
      };
      const res = await request(app)
        .put('/api/config')
        .set('Content-Type', 'application/json')
        .send(updated);
      assert.equal(res.status, 200);
      assert.equal(res.body.ok, true);
    });
  });

  describe('GET /api/jobs', () => {
    it('returns job states', async () => {
      const app = createServer(config, configPath);
      const res = await request(app).get('/api/jobs');
      assert.equal(res.status, 200);
      assert.ok(Array.isArray(res.body));
      assert.equal(res.body[0].name, 'test-job');
    });
  });

  describe('POST /api/jobs/:id/trigger', () => {
    it('returns 404 for unknown job id', async () => {
      const app = createServer(config, configPath);
      const res = await request(app)
        .post('/api/jobs/nonexistent/trigger')
        .set('Content-Type', 'application/json')
        .send({});
      assert.equal(res.status, 404);
    });
  });

  describe('Security headers', () => {
    it('sets security headers on responses', async () => {
      const app = createServer(config, configPath);
      const res = await request(app).get('/api/status');
      assert.equal(res.headers['x-content-type-options'], 'nosniff');
      assert.equal(res.headers['x-frame-options'], 'DENY');
      assert.equal(res.headers['referrer-policy'], 'no-referrer');
      assert.ok(res.headers['content-security-policy']);
    });
  });

  describe('Content-Type enforcement', () => {
    it('rejects POST without JSON content-type', async () => {
      const app = createServer(config, configPath);
      const res = await request(app)
        .post('/api/jobs/job1/trigger')
        .set('Content-Type', 'text/plain')
        .send('{}');
      assert.equal(res.status, 415);
    });
  });

  describe('GET /api/recordings', () => {
    it('returns empty array when no recordings exist', async () => {
      const app = createServer(config, configPath);
      const res = await request(app).get('/api/recordings');
      assert.equal(res.status, 200);
      assert.deepEqual(res.body, []);
    });

    it('lists mp4 files from output dir', async () => {
      await fs.writeFile(path.join(tmpDir, 'test.mp4'), 'fake-content');
      // Use a fresh server instance to avoid cache from previous test
      const freshConfig = makeConfig({ outputDir: tmpDir });
      const app = createServer(freshConfig, configPath);
      const res = await request(app).get('/api/recordings');
      assert.equal(res.status, 200);
      assert.equal(res.body.length, 1);
      assert.equal(res.body[0].name, 'test.mp4');
    });
  });

  describe('Path traversal protection', () => {
    it('rejects GET with ../ in filename', async () => {
      const app = createServer(config, configPath);
      const res = await request(app).get('/api/recordings/..%2F..%2Fetc%2Fpasswd.mp4');
      assert.equal(res.status, 400);
    });

    it('rejects DELETE with ../ in filename', async () => {
      const app = createServer(config, configPath);
      const res = await request(app)
        .delete('/api/recordings/..%2Fsomefile.mp4')
        .set('Content-Type', 'application/json')
        .send({});
      assert.equal(res.status, 400);
    });

    it('rejects non-mp4 filenames', async () => {
      const app = createServer(config, configPath);
      const res = await request(app).get('/api/recordings/config.json');
      assert.equal(res.status, 400);
    });
  });

  describe('POST /api/browser/set-viewport', () => {
    it('rejects non-integer dimensions', async () => {
      const app = createServer(config, configPath);
      const res = await request(app)
        .post('/api/browser/set-viewport')
        .set('Content-Type', 'application/json')
        .send({ width: 'abc', height: 100 });
      assert.equal(res.status, 400);
    });

    it('rejects viewport exceeding 8K', async () => {
      const app = createServer(config, configPath);
      const res = await request(app)
        .post('/api/browser/set-viewport')
        .set('Content-Type', 'application/json')
        .send({ width: 8000, height: 5000 });
      assert.equal(res.status, 400);
      assert.ok(res.body.error.includes('8K'));
    });
  });

  describe('GET /api/dashboard', () => {
    it('returns consolidated dashboard data', async () => {
      const app = createServer(config, configPath);
      const res = await request(app).get('/api/dashboard');
      assert.equal(res.status, 200);
      assert.ok(Array.isArray(res.body.jobs));
      assert.ok(Array.isArray(res.body.active));
      assert.ok(Array.isArray(res.body.completed));
      assert.ok(res.body.status);
      assert.equal(res.body.status.mode, 'connect');
    });
  });
});
