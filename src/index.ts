import fs from 'node:fs/promises';
import { loadConfig, setConfigPath, getConfigPath } from './config.js';
import { runPreflightChecks } from './preflight.js';
import { launchBrowser, closeBrowser, disconnectBrowser } from './browser.js';
import { startScheduler, stopScheduler, stopAllRecordings, getActiveRecordings } from './scheduler.js';
import { createServer } from './server.js';
import { stopDebugChrome } from './chrome-launcher.js';

async function main(): Promise<void> {
  const configFile = process.argv[2] || 'config.json';
  setConfigPath(configFile);

  // Copy default config if user config doesn't exist
  try {
    await fs.access(configFile);
  } catch {
    try {
      await fs.copyFile('config.default.json', configFile);
      console.log(`Created ${configFile} from default config`);
    } catch {
      // No default config either — loadConfig will fail with a clear message
    }
  }

  // Load config
  let config;
  try {
    config = await loadConfig(configFile);
  } catch (err) {
    console.error(`Failed to load config from ${configFile}:`);
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  console.log(`croncast starting (config: ${configFile})`);
  console.log(`Mode: ${config.executablePath ? 'launch' : 'connect'}`);
  console.log(`Output: ${config.outputDir}`);
  console.log(`Jobs: ${config.jobs.length}`);
  console.log();

  // Preflight checks
  const results = await runPreflightChecks(config);
  const icons = { pass: '\u2713', warn: '\u26A0', fail: '\u2717' };
  let hasFatal = false;

  for (const r of results) {
    const icon = icons[r.status];
    console.log(`  ${icon} ${r.name}: ${r.message}`);
    if (r.detail) {
      console.log(`    ${r.detail}`);
    }
    if (r.status === 'fail') hasFatal = true;
  }
  console.log();

  if (hasFatal) {
    console.error('Fatal preflight check(s) failed. Exiting.');
    process.exit(1);
  }

  // Launch browser if launch mode
  if (config.executablePath) {
    try {
      await launchBrowser(config.executablePath, config.headless);
    } catch (err) {
      console.error('Failed to launch browser:');
      console.error(err);
      process.exit(1);
    }
  }

  // Create output directory
  await fs.mkdir(config.outputDir, { recursive: true });

  // Start scheduler
  startScheduler(config);

  // Start web server
  const app = createServer(config, getConfigPath());
  const server = app.listen(config.port, '127.0.0.1', () => {
    console.log(`Web UI: http://localhost:${config.port}`);
  });

  // Shutdown handlers
  const shutdown = async () => {
    console.log('\nShutting down...');
    server.close();
    stopScheduler();
    const stopped = stopAllRecordings();
    if (stopped > 0) {
      console.log(`Stopped ${stopped} active recording(s), waiting up to 5s for flush...`);
      const deadline = Date.now() + 5000;
      while (getActiveRecordings().length > 0 && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 250));
      }
      const remaining = getActiveRecordings().length;
      if (remaining > 0) {
        console.log(`${remaining} recording(s) did not finish flushing`);
      }
    }
    stopDebugChrome();
    disconnectBrowser();
    await closeBrowser();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main();
