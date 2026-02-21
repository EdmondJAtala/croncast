import express from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AppConfig, validateConfig, saveConfig } from './config.js';
import { getPreflightResults } from './preflight.js';
import { getJobStates, restartScheduler, triggerJob, getActiveRecordings, getCompletedRecordings, stopRecording, stopAllRecordings } from './scheduler.js';
import { testJob, setViewportOnAll } from './recorder.js';
import { launchDebugChrome, stopDebugChrome, getDebugChromeStatus, parsePortFromURL } from './chrome-launcher.js';
import { ConfigError, PageNotFoundError, BrowserConnectionError } from './errors.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const startTime = Date.now();

const RECORDINGS_CACHE_TTL = 5000;

export function createServer(config: AppConfig, configPath: string): express.Express {
  const app = express();

  // Recordings file-list cache (per server instance, avoids readdir+stat on every poll)
  let recordingsCache: { data: unknown; expiry: number } | null = null;

  app.use(express.json({ limit: '100kb' }));

  // Security headers
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'");
    next();
  });

  app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1h' }));

  // Require JSON content type on API mutations (CSRF protection)
  app.use('/api', (req, res, next) => {
    if (['POST', 'PUT', 'DELETE'].includes(req.method)) {
      const ct = req.headers['content-type'] || '';
      if (!ct.includes('application/json')) {
        res.status(415).json({ error: 'Content-Type must be application/json' });
        return;
      }
    }
    next();
  });

  // GET /api/status
  app.get('/api/status', (_req, res) => {
    res.json({
      preflight: getPreflightResults(),
      uptime: Math.floor((Date.now() - startTime) / 1000),
      mode: config.executablePath ? 'launch' : 'connect',
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    });
  });

  // GET /api/config
  app.get('/api/config', (_req, res) => {
    res.json(config);
  });

  // PUT /api/config
  app.put('/api/config', async (req, res) => {
    try {
      const newConfig = validateConfig(req.body);
      await saveConfig(configPath, newConfig);
      // Replace all properties atomically
      for (const key of Object.keys(config)) delete (config as any)[key];
      Object.assign(config, newConfig);
      restartScheduler(config);
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // GET /api/jobs
  app.get('/api/jobs', (_req, res) => {
    res.json(getJobStates());
  });

  // POST /api/jobs/:id/test
  app.post('/api/jobs/:id/test', async (req, res) => {
    const job = config.jobs.find(j => j.id === req.params.id);
    if (!job) {
      res.status(404).json({ error: `Job "${req.params.id}" not found` });
      return;
    }
    try {
      const result = await testJob(config, job);
      res.json(result);
    } catch (err) {
      if (err instanceof ConfigError) {
        res.status(400).json({ error: err.message });
      } else if (err instanceof PageNotFoundError) {
        res.status(404).json({ error: err.message });
      } else if (err instanceof BrowserConnectionError) {
        res.status(502).json({ error: err.message });
      } else {
        res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
      }
    }
  });

  // POST /api/jobs/:id/trigger
  app.post('/api/jobs/:id/trigger', (req, res) => {
    const job = config.jobs.find(j => j.id === req.params.id);
    if (!job) {
      res.status(404).json({ error: `Job "${req.params.id}" not found` });
      return;
    }
    const result = triggerJob(config, job.id!);
    if (!result.triggered) {
      res.status(409).json({ error: result.reason });
      return;
    }
    res.json({ ok: true, message: `Recording triggered for "${job.name}"` });
  });

  // POST /api/jobs/:id/toggle
  app.post('/api/jobs/:id/toggle', async (req, res) => {
    const job = config.jobs.find(j => j.id === req.params.id);
    if (!job) {
      res.status(404).json({ error: `Job "${req.params.id}" not found` });
      return;
    }
    job.enabled = job.enabled === false ? true : false;
    try {
      await saveConfig(configPath, config);
      restartScheduler(config);
      res.json({ ok: true, enabled: job.enabled });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // GET /api/recordings/active
  app.get('/api/recordings/active', (_req, res) => {
    res.json(getActiveRecordings());
  });

  // GET /api/recordings/completed
  app.get('/api/recordings/completed', (_req, res) => {
    res.json(getCompletedRecordings());
  });

  // POST /api/recordings/active/stop-all (must be before :id route)
  app.post('/api/recordings/active/stop-all', (_req, res) => {
    const count = stopAllRecordings();
    res.json({ ok: true, stopped: count });
  });

  // POST /api/recordings/active/:id/stop
  app.post('/api/recordings/active/:id/stop', (req, res) => {
    const stopped = stopRecording(req.params.id);
    if (stopped) {
      res.json({ ok: true, message: `Recording stopped: "${req.params.id}"` });
    } else {
      res.status(404).json({ error: `No active recording with id "${req.params.id}"` });
    }
  });

  // GET /api/recordings (cached)
  app.get('/api/recordings', async (_req, res) => {
    if (recordingsCache && Date.now() < recordingsCache.expiry) {
      res.json(recordingsCache.data);
      return;
    }
    try {
      const dir = config.outputDir;
      let files: string[];
      try {
        files = await fs.readdir(dir);
      } catch {
        res.json([]);
        return;
      }

      const mp4Files = files.filter(f => f.endsWith('.mp4'));
      const results = (await Promise.all(
        mp4Files.map(async (name) => {
          try {
            const stat = await fs.stat(path.join(dir, name));
            return {
              name,
              size: stat.size,
              created: stat.birthtime.toISOString(),
              modified: stat.mtime.toISOString(),
            };
          } catch {
            return null; // file deleted between readdir and stat
          }
        })
      )).filter((r): r is NonNullable<typeof r> => r !== null);

      results.sort((a, b) => b.modified.localeCompare(a.modified));
      recordingsCache = { data: results, expiry: Date.now() + RECORDINGS_CACHE_TTL };
      res.json(results);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // Validate recording filename and resolve safe path within outputDir
  function resolveRecordingPath(filename: string): string | null {
    if (!filename.endsWith('.mp4')) return null;
    const resolved = path.resolve(config.outputDir, filename);
    const outputDirResolved = path.resolve(config.outputDir);
    if (!resolved.startsWith(outputDirResolved + path.sep) && resolved !== outputDirResolved) return null;
    return resolved;
  }

  // GET /api/recordings/:filename
  app.get('/api/recordings/:filename', (req, res) => {
    const filePath = resolveRecordingPath(req.params.filename);
    if (!filePath) {
      res.status(400).json({ error: 'Invalid filename' });
      return;
    }
    res.sendFile(filePath);
  });

  // DELETE /api/recordings/:filename
  app.delete('/api/recordings/:filename', async (req, res) => {
    const filePath = resolveRecordingPath(req.params.filename);
    if (!filePath) {
      res.status(400).json({ error: 'Invalid filename' });
      return;
    }
    try {
      await fs.unlink(filePath);
      recordingsCache = null;
      res.json({ ok: true });
    } catch {
      res.status(404).json({ error: 'File not found' });
    }
  });

  // POST /api/browser/set-viewport
  app.post('/api/browser/set-viewport', async (req, res) => {
    const { width, height } = req.body || {};
    if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
      res.status(400).json({ error: 'width and height must be positive integers' });
      return;
    }
    if (width > 7680 || height > 4320) {
      res.status(400).json({ error: 'Maximum viewport size is 7680x4320 (8K)' });
      return;
    }
    try {
      const result = await setViewportOnAll(config, width, height);
      res.json({ ok: true, pagesUpdated: result.pagesUpdated });
    } catch (err) {
      if (err instanceof BrowserConnectionError) {
        res.status(502).json({ error: err.message });
      } else {
        res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
      }
    }
  });

  // POST /api/debug-chrome/launch
  app.post('/api/debug-chrome/launch', async (req, res) => {
    if (config.executablePath) {
      res.status(400).json({ error: 'Cannot launch debug Chrome in launch mode' });
      return;
    }
    const chromePath: string = req.body?.chromePath || config.chromePath || '';
    if (!chromePath) {
      res.status(400).json({ error: 'No Chrome path provided' });
      return;
    }
    const port = parsePortFromURL(config.browserURL || 'http://localhost:9222');
    try {
      launchDebugChrome(chromePath, port);
      // Wait briefly to detect immediate spawn failures
      await new Promise(resolve => setTimeout(resolve, 500));
      const status = getDebugChromeStatus();
      if (!status.running) {
        res.status(500).json({ error: 'Chrome failed to start — check the path' });
        return;
      }
      res.json({ ok: true, ...status });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // POST /api/debug-chrome/stop
  app.post('/api/debug-chrome/stop', (_req, res) => {
    stopDebugChrome();
    res.json({ ok: true });
  });

  // GET /api/debug-chrome/status
  app.get('/api/debug-chrome/status', (_req, res) => {
    res.json(getDebugChromeStatus());
  });

  // GET /api/dashboard — consolidated endpoint for frequent polling
  app.get('/api/dashboard', (_req, res) => {
    res.json({
      jobs: getJobStates(),
      active: getActiveRecordings(),
      completed: getCompletedRecordings(),
      status: {
        preflight: getPreflightResults(),
        uptime: Math.floor((Date.now() - startTime) / 1000),
        mode: config.executablePath ? 'launch' : 'connect',
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      },
      debugChrome: getDebugChromeStatus(),
    });
  });

  return app;
}
