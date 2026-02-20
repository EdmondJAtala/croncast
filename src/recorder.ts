import { type Browser, type Page } from 'puppeteer-core';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { AppConfig, JobConfig } from './config.js';
import { getLaunchedBrowser, ensureBrowser, ensureConnectedBrowser } from './browser.js';
import { RecordingError, PageNotFoundError } from './errors.js';
import { getFfmpegPath } from './ffmpeg-path.js';

export function makeTimestamp(): string {
  return new Date().toISOString().replace(/:/g, '');
}

async function recordPage(page: Page, outputPath: string, durationSeconds: number, captureFps: number, signal?: AbortSignal): Promise<void> {
  const captureInterval = 1000 / captureFps;

  const proc = spawn(getFfmpegPath(), [
    '-f', 'mjpeg',
    '-framerate', captureFps.toString(),
    '-i', '-',
    '-vf', 'pad=ceil(iw/2)*2:ceil(ih/2)*2',
    '-c:v', 'libx264',
    '-preset', 'fast',
    '-crf', '18',
    '-pix_fmt', 'yuv420p',
    '-an',
    '-y',
    outputPath,
  ], { stdio: ['pipe', 'ignore', 'pipe'] });

  let stderr = '';
  proc.stderr.on('data', (d: Buffer) => {
    stderr += d.toString();
    if (stderr.length > 4096) stderr = stderr.slice(-4096);
  });
  proc.stdin.on('error', () => {}); // handled via proc 'close' event

  let ffmpegDone = false;
  const procDone = new Promise<void>((resolve, reject) => {
    proc.on('error', (err) => { ffmpegDone = true; reject(new RecordingError(`ffmpeg failed to start: ${err.message}`)); });
    proc.on('close', (code) => {
      ffmpegDone = true;
      if (code === 0) resolve();
      else reject(new RecordingError(`ffmpeg exited with code ${code}: ${stderr.slice(-500)}`));
    });
  });
  procDone.catch(() => {});

  let totalFrames = 0;
  let totalBytes = 0;
  const startTime = Date.now();

  while (!ffmpegDone && !signal?.aborted) {
    const elapsed = (Date.now() - startTime) / 1000;
    if (elapsed >= durationSeconds) break;

    try {
      const jpeg = await page.screenshot({ type: 'jpeg', quality: 65, encoding: 'binary' }) as Buffer;
      if (proc.stdin.destroyed) break;

      const ok = proc.stdin.write(jpeg);
      totalFrames++;
      totalBytes += jpeg.length;

      if (totalFrames === 1) {
        console.log(`  First frame captured (${jpeg.length} bytes), recording in progress...`);
      }

      // Respect backpressure — wait for pipe to drain before next frame (10s timeout prevents hang if ffmpeg dies)
      if (!ok && !proc.stdin.destroyed) {
        const drained = await Promise.race([
          new Promise<boolean>(resolve => proc.stdin.once('drain', () => resolve(true))),
          new Promise<boolean>(resolve => setTimeout(() => resolve(false), 10000)),
        ]);
        if (!drained) {
          console.log('  ffmpeg drain timeout (10s), ending recording');
          break;
        }
      }
    } catch (err) {
      console.log(`  Screenshot failed, ending recording: ${err instanceof Error ? err.message : String(err)}`);
      break;
    }

    // Sleep to maintain target capture rate (anchored to wall clock to prevent drift)
    const nextFrameAt = startTime + totalFrames * captureInterval;
    const sleepMs = Math.max(0, nextFrameAt - Date.now());
    if (sleepMs > 0) {
      await new Promise<void>(resolve => setTimeout(resolve, sleepMs));
    }
  }

  if (!proc.stdin.destroyed) {
    proc.stdin.end();
  }

  console.log(`  Frames: ${totalFrames} captured (${(totalBytes / 1024 / 1024).toFixed(1)} MB)`);

  if (totalFrames === 0) {
    await procDone.catch(() => {});
    throw new RecordingError('Recording captured 0 frames — screenshot failed immediately');
  }

  await procDone;
}

async function findPage(browser: Browser, job: JobConfig): Promise<{ page: Page; opened: boolean }> {
  const pages = await browser.pages();

  // Try urlPattern match first
  if (job.urlPattern) {
    for (const page of pages) {
      if (page.url().includes(job.urlPattern)) {
        return { page, opened: false };
      }
    }
  }

  // Navigate to url
  if (job.url) {
    const page = await browser.newPage();
    await page.goto(job.url, { waitUntil: 'networkidle2', timeout: 30000 });
    return { page, opened: true };
  }

  throw new PageNotFoundError(`No tab matches urlPattern "${job.urlPattern}" and no url is configured`);
}

export interface RecordingResult {
  success: boolean;
  outputPath?: string;
  error?: string;
}

export async function record(config: AppConfig, job: JobConfig, outputPath: string, signal?: AbortSignal): Promise<RecordingResult> {
  const isLaunchMode = !!config.executablePath;
  let page: Page | null = null;
  let openedPage = false;

  try {
    let browser: Browser;
    if (isLaunchMode) {
      browser = await ensureBrowser(config.executablePath!, config.headless);
    } else {
      browser = await ensureConnectedBrowser(config.browserURL!);
    }

    const found = await findPage(browser, job);
    page = found.page;
    openedPage = found.opened;

    if (job.viewportWidth && job.viewportHeight) {
      await page.setViewport({ width: job.viewportWidth, height: job.viewportHeight });
    }

    console.log(`Recording "${job.name}" for ${job.durationSeconds}s...`);
    await recordPage(page, outputPath, job.durationSeconds, job.captureFps || 2, signal);
    console.log(`Recording complete: ${outputPath}`);

    return { success: true, outputPath };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Recording error for "${job.name}": ${message}`);
    return { success: false, outputPath, error: message };
  } finally {
    try {
      if (page && openedPage) await page.close();
    } catch { /* already closed */ }
  }
}

export async function setViewportOnAll(config: AppConfig, width: number, height: number): Promise<{ pagesUpdated: number }> {
  const isLaunchMode = !!config.executablePath;
  let browser: Browser;

  if (isLaunchMode) {
    const launched = getLaunchedBrowser();
    if (!launched || !launched.connected) {
      throw new Error('Launched browser is not running');
    }
    browser = launched;
  } else {
    browser = await ensureConnectedBrowser(config.browserURL!);
  }

  const pages = await browser.pages();
    if (pages.length === 0) return { pagesUpdated: 0 };

    // Resize the actual browser window via CDP
    const client = await pages[0].createCDPSession();
    try {
      const { windowId, bounds } = await client.send('Browser.getWindowForTarget');

      // Un-maximize/fullscreen first — setWindowBounds requires normal state
      if (bounds.windowState && bounds.windowState !== 'normal') {
        await client.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });
      }

      // Calculate chrome overhead (title bar, address bar, borders)
      const contentSize = await pages[0].evaluate(() => ({
        w: window.innerWidth,
        h: window.innerHeight,
      }));
      const chromeW = (bounds.width || 0) - contentSize.w;
      const chromeH = (bounds.height || 0) - contentSize.h;

      await client.send('Browser.setWindowBounds', {
        windowId,
        bounds: { width: width + chromeW, height: height + chromeH },
      });
    } finally {
      await client.detach();
    }

    // Set viewport on every page so the content area is exact
    let updated = 0;
    for (const page of pages) {
      await page.setViewport({ width, height });
      updated++;
    }
    return { pagesUpdated: updated };
}

export interface TestStepResult {
  name: string;
  status: 'pass' | 'fail';
  message?: string;
}

export interface TestResult {
  steps: TestStepResult[];
  screenshot?: string;
}

export async function testJob(config: AppConfig, job: JobConfig): Promise<TestResult> {
  const steps: TestStepResult[] = [];
  let browser: Browser | null = null;
  let page: Page | null = null;
  let openedPage = false;
  const isLaunchMode = !!config.executablePath;

  // Step 1: Browser connection
  try {
    if (isLaunchMode) {
      browser = await ensureBrowser(config.executablePath!, config.headless);
      steps.push({
        name: 'Browser connection',
        status: 'pass',
        message: `Connected to launched browser`,
      });
    } else {
      browser = await ensureConnectedBrowser(config.browserURL!);
      steps.push({
        name: 'Browser connection',
        status: 'pass',
        message: `Connected to browser at ${config.browserURL}`,
      });
    }
  } catch (err) {
    steps.push({
      name: 'Browser connection',
      status: 'fail',
      message: `Cannot reach browser: ${err instanceof Error ? err.message : String(err)}`,
    });
    return { steps };
  }

  // Step 2: Find target page
  try {
    const found = await findPage(browser, job);
    page = found.page;
    openedPage = found.opened;
    steps.push({
      name: 'Find target page',
      status: 'pass',
      message: `Found tab: ${await page.title()} (${page.url()})`,
    });
  } catch (err) {
    steps.push({
      name: 'Find target page',
      status: 'fail',
      message: err instanceof Error ? err.message : String(err),
    });
    return { steps };
  }

  // Step 2.5: Set viewport if configured
  if (job.viewportWidth && job.viewportHeight) {
    try {
      await page.setViewport({ width: job.viewportWidth, height: job.viewportHeight });
      steps.push({
        name: 'Set viewport',
        status: 'pass',
        message: `Viewport set to ${job.viewportWidth}x${job.viewportHeight}`,
      });
    } catch (err) {
      steps.push({
        name: 'Set viewport',
        status: 'fail',
        message: `Failed to set viewport: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  // Step 3: Screenshot
  let screenshot: string | undefined;
  try {
    const buf = await page.screenshot({ encoding: 'base64' });
    screenshot = `data:image/png;base64,${buf}`;
    steps.push({ name: 'Screenshot', status: 'pass' });
  } catch (err) {
    steps.push({
      name: 'Screenshot',
      status: 'fail',
      message: `Screenshot failed: ${err instanceof Error ? err.message : String(err)}`,
    });
    if (openedPage) await page.close().catch(() => {});
    return { steps, screenshot };
  }

  // Step 4: Recording probe (3 seconds)
  const tempDir = config.outputDir;
  await fs.mkdir(tempDir, { recursive: true });
  const testMp4 = path.join(tempDir, `_test_${Date.now()}.mp4`);

  try {
    const start = Date.now();
    await recordPage(page, testMp4, 3, 2);
    const elapsed = Date.now() - start;

    const stat = await fs.stat(testMp4);
    const sizeKB = Math.round(stat.size / 1024);
    steps.push({
      name: 'Recording probe',
      status: 'pass',
      message: `Recording captured and encoded successfully (${sizeKB} KB, ${elapsed}ms)`,
    });
  } catch (err) {
    steps.push({
      name: 'Recording probe',
      status: 'fail',
      message: `Recording failed: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  // Cleanup page
  if (openedPage && page) {
    await page.close().catch(() => {});
  }

  // Step 5: Cleanup (silent)
  await fs.unlink(testMp4).catch(() => {});

  return { steps, screenshot };
}
