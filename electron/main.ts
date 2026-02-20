import { app, BrowserWindow, ipcMain } from 'electron';
import electronUpdater from 'electron-updater';
const { autoUpdater } = electronUpdater;
import path from 'node:path';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Resolve ffmpeg path BEFORE importing any app modules
function resolveFfmpegPath(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'ffmpeg.exe');
  }
  // Dev mode: use ffmpeg-static from node_modules
  const staticPath = path.join(app.getAppPath(), 'node_modules', 'ffmpeg-static', 'ffmpeg.exe');
  if (fs.existsSync(staticPath)) return staticPath;
  // Fallback to PATH
  return 'ffmpeg';
}

async function main(): Promise<void> {
  // 1. Set ffmpeg path before anything else
  const { setFfmpegPath } = await import('../dist/ffmpeg-path.js');
  setFfmpegPath(resolveFfmpegPath());

  // 2. Set config path to userData
  const { setConfigPath, loadConfig } = await import('../dist/config.js');
  const userDataPath = app.getPath('userData');
  const configFile = path.join(userDataPath, 'config.json');
  setConfigPath(configFile);

  // 3. Copy default config on first run
  try {
    fs.accessSync(configFile);
  } catch {
    const defaultConfig = app.isPackaged
      ? path.join(process.resourcesPath, 'config.default.json')
      : path.join(app.getAppPath(), 'config.default.json');
    try {
      fs.copyFileSync(defaultConfig, configFile);
      console.log(`Created ${configFile} from default config`);
    } catch {
      // loadConfig will fail with a clear message
    }
  }

  // 4. Load config
  let config;
  try {
    config = await loadConfig(configFile);
  } catch (err) {
    console.error(`Failed to load config from ${configFile}:`);
    console.error(err instanceof Error ? err.message : String(err));
    app.quit();
    return;
  }

  // 5. Resolve relative outputDir to absolute under userData
  if (!path.isAbsolute(config.outputDir)) {
    config.outputDir = path.join(userDataPath, config.outputDir);
  }
  await fsPromises.mkdir(config.outputDir, { recursive: true });

  console.log(`croncast starting (Electron, config: ${configFile})`);
  console.log(`Mode: ${config.executablePath ? 'launch' : 'connect'}`);
  console.log(`Output: ${config.outputDir}`);
  console.log(`Jobs: ${config.jobs.length}`);

  // 6. Preflight checks
  const { runPreflightChecks } = await import('../dist/preflight.js');
  const results = await runPreflightChecks(config);
  const icons = { pass: '\u2713', warn: '\u26A0', fail: '\u2717' } as const;
  let hasFatal = false;
  for (const r of results) {
    console.log(`  ${icons[r.status]} ${r.name}: ${r.message}`);
    if (r.detail) console.log(`    ${r.detail}`);
    if (r.status === 'fail') hasFatal = true;
  }
  if (hasFatal) {
    console.error('Fatal preflight check(s) failed. Exiting.');
    app.quit();
    return;
  }

  // 7. Launch browser if launch mode
  if (config.executablePath) {
    const { launchBrowser } = await import('../dist/browser.js');
    try {
      await launchBrowser(config.executablePath, config.headless);
    } catch (err) {
      console.error('Failed to launch browser:', err);
      app.quit();
      return;
    }
  }

  // 8. Start scheduler
  const { startScheduler, stopScheduler, stopAllRecordings, getActiveRecordings } = await import('../dist/scheduler.js');
  startScheduler(config);

  // 9. Start Express server
  const { createServer } = await import('../dist/server.js');
  const { getConfigPath } = await import('../dist/config.js');
  const expressApp = createServer(config, getConfigPath());
  const server = expressApp.listen(config.port, '127.0.0.1', () => {
    console.log(`Web UI: http://localhost:${config.port}`);
  });

  // 10. Create BrowserWindow
  const win = new BrowserWindow({
    width: 800,
    height: 800,
    minWidth: 500,
    minHeight: 400,
    title: `croncast v${app.getVersion()}`,
    frame: false,
    webPreferences: {
      preload: path.join(app.getAppPath(), 'electron', 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Clear cached static files so dev changes take effect immediately
  await win.webContents.session.clearCache();
  await win.loadURL(`http://127.0.0.1:${config.port}`);

  // 11. IPC handlers
  ipcMain.on('get-version', (event) => {
    event.returnValue = app.getVersion();
  });

  ipcMain.on('install-update', () => {
    autoUpdater.quitAndInstall();
  });

  ipcMain.on('window-minimize', () => win.minimize());
  ipcMain.on('window-maximize', () => {
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
  });
  ipcMain.on('window-close', () => win.close());

  // 12. Auto-updater
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('update-available', () => {
    win.webContents.send('update-available');
  });

  autoUpdater.on('update-downloaded', () => {
    win.webContents.send('update-downloaded');
  });

  autoUpdater.on('error', (err) => {
    console.error('Auto-update error:', err.message);
  });

  // Check for updates after a short delay
  setTimeout(() => {
    autoUpdater.checkForUpdates().catch((err) => {
      console.error('Update check failed:', err.message);
    });
  }, 5000);

  // 13. Graceful shutdown
  const { stopDebugChrome } = await import('../dist/chrome-launcher.js');
  const { disconnectBrowser, closeBrowser } = await import('../dist/browser.js');

  let isQuitting = false;
  const shutdown = async () => {
    if (isQuitting) return;
    isQuitting = true;
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
    app.quit();
  };

  win.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault();
      shutdown();
    }
  });

  app.on('window-all-closed', () => {
    if (!isQuitting) shutdown();
  });
}

app.whenReady().then(main).catch((err) => {
  console.error('Fatal error:', err);
  app.quit();
});
