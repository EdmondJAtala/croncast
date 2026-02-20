import puppeteer, { type Browser } from 'puppeteer-core';
import { BrowserConnectionError } from './errors.js';

let launchedBrowser: Browser | null = null;
let browserLaunchPromise: Promise<Browser> | null = null;

export function getLaunchedBrowser(): Browser | null {
  return launchedBrowser;
}

export async function launchBrowser(executablePath: string, headless?: boolean): Promise<Browser> {
  try {
    launchedBrowser = await puppeteer.launch({
      executablePath,
      headless: headless ?? false,
      protocolTimeout: 0,
      defaultViewport: null,
      args: ['--no-first-run', '--no-default-browser-check', '--force-device-scale-factor=1', '--start-maximized'],
    });
    console.log(`Browser launched: ${executablePath}`);
    return launchedBrowser;
  } catch (err) {
    throw new BrowserConnectionError(`Failed to launch browser: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// Prevents concurrent browser launches from leaking browser processes
export async function ensureBrowser(executablePath: string, headless?: boolean): Promise<Browser> {
  if (launchedBrowser && launchedBrowser.connected) {
    return launchedBrowser;
  }
  if (browserLaunchPromise) {
    return browserLaunchPromise;
  }
  console.log('Browser disconnected, attempting relaunch...');
  browserLaunchPromise = launchBrowser(executablePath, headless).finally(() => {
    browserLaunchPromise = null;
  });
  return browserLaunchPromise;
}

export async function closeBrowser(): Promise<void> {
  if (launchedBrowser) {
    try {
      await launchedBrowser.close();
    } catch {
      // already closed
    }
    launchedBrowser = null;
  }
}

// Cached connect-mode browser (reused across recordings)
let connectedBrowser: Browser | null = null;
let browserConnectPromise: Promise<Browser> | null = null;

export async function ensureConnectedBrowser(browserURL: string): Promise<Browser> {
  if (connectedBrowser && connectedBrowser.connected) {
    return connectedBrowser;
  }
  if (browserConnectPromise) {
    return browserConnectPromise;
  }
  browserConnectPromise = Promise.race([
    puppeteer.connect({
      browserURL,
      defaultViewport: null,
      protocolTimeout: 0,
    }),
    new Promise<never>((_, reject) => setTimeout(() => reject(new BrowserConnectionError(`Browser connection timed out after 30s (${browserURL})`)), 30000)),
  ]).then(browser => {
    connectedBrowser = browser;
    browser.on('disconnected', () => { connectedBrowser = null; });
    return browser;
  }).catch(err => {
    throw new BrowserConnectionError(`Failed to connect to browser at ${browserURL}: ${err instanceof Error ? err.message : String(err)}`);
  }).finally(() => {
    browserConnectPromise = null;
  });
  return browserConnectPromise;
}

export function disconnectBrowser(): void {
  if (connectedBrowser) {
    try { connectedBrowser.disconnect(); } catch { /* already disconnected */ }
    connectedBrowser = null;
  }
}
