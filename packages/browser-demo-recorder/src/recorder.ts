import { spawn } from 'node:child_process';
import { access, mkdir, rename, stat } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium, type Locator, type Page } from 'playwright';

const videoSize = { width: 1280, height: 720 };
const scenarioTimeoutMs = 60_000;

export type ScenarioContext = {
  page: Page;
  caption(text: string, durationMs?: number): Promise<void>;
  click(target: Locator): Promise<void>;
  hover(target: Locator): Promise<void>;
};

export type Scenario = (context: ScenarioContext) => Promise<void>;

export type RecordingResult = {
  path: string;
  format: 'mp4' | 'webm';
  durationMs: number;
  sizeBytes: number;
};

export async function loadScenario(scenarioPath: string): Promise<Scenario> {
  const absolutePath = path.resolve(scenarioPath);
  await access(absolutePath);
  const module = (await import(`${pathToFileURL(absolutePath).href}?t=${Date.now()}`)) as { default?: unknown };
  if (typeof module.default !== 'function') throw new Error('scenario must export a default async function');
  return module.default as Scenario;
}

export async function recordScenario(scenario: Scenario, outputDir: string): Promise<RecordingResult> {
  const absoluteOutputDir = path.resolve(outputDir);
  const rawDir = path.join(absoluteOutputDir, 'raw');
  await mkdir(rawDir, { recursive: true });

  const browser = await chromium.launch({ channel: 'chromium' });
  let context;
  let video;
  let recordingStartedAt = 0;
  let recordingDurationMs: number;

  try {
    context = await browser.newContext({ viewport: videoSize, recordVideo: { dir: rawDir, size: videoSize } });
    await context.addInitScript(installOverlay);
    const page = await context.newPage();
    video = page.video();
    recordingStartedAt = Date.now();
    await Promise.race([
      scenario(createScenarioContext(page)),
      new Promise<never>((_, reject) => {
        const timer = setTimeout(
          () => reject(new Error('scenario exceeded the 60 second recording limit')),
          scenarioTimeoutMs,
        );
        timer.unref();
      }),
    ]);
  } finally {
    recordingDurationMs = recordingStartedAt ? Date.now() - recordingStartedAt : 0;
    await context?.close();
    await browser.close();
  }

  if (!video) throw new Error('Playwright did not create a video recording');
  const rawPath = await video.path();
  const webmPath = path.join(absoluteOutputDir, 'browser-demo.webm');
  await rename(rawPath, webmPath);
  const mp4Path = path.join(absoluteOutputDir, 'browser-demo.mp4');
  const transcoded = await transcodeToMp4(webmPath, mp4Path);
  const finalPath = transcoded ? mp4Path : webmPath;
  const file = await stat(finalPath);

  return {
    path: finalPath,
    format: transcoded ? 'mp4' : 'webm',
    durationMs: (await mediaDurationMs(finalPath)) ?? recordingDurationMs,
    sizeBytes: file.size,
  };
}

export async function transcodeToMp4(inputPath: string, outputPath: string): Promise<boolean> {
  try {
    await runCommand('ffmpeg', [
      '-y',
      '-loglevel',
      'error',
      '-i',
      inputPath,
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-movflags',
      '+faststart',
      outputPath,
    ]);
    return true;
  } catch (error) {
    process.stderr.write(
      `MP4 transcode unavailable; keeping WebM: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return false;
  }
}

function createScenarioContext(page: Page): ScenarioContext {
  const moveTo = async (target: Locator) => {
    await target.waitFor({ state: 'visible' });
    const box = await target.boundingBox();
    if (box) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 8 });
  };
  return {
    page,
    async caption(text, durationMs = 1_200) {
      await page.evaluate(
        ({ value, duration }) => {
          const element = document.querySelector<HTMLElement>('[data-deputies-caption]');
          if (!element) return;
          element.textContent = value;
          element.style.opacity = '1';
          window.setTimeout(() => {
            element.style.opacity = '0';
          }, duration);
        },
        { value: text, duration: durationMs },
      );
      await page.waitForTimeout(Math.min(durationMs, 1_500));
    },
    async click(target) {
      await moveTo(target);
      await target.click();
    },
    async hover(target) {
      await moveTo(target);
      await target.hover();
    },
  };
}

function installOverlay(): void {
  const install = () => {
    if (document.querySelector('[data-deputies-cursor]')) return;
    const cursor = document.createElement('div');
    cursor.dataset.deputiesCursor = '';
    Object.assign(cursor.style, {
      position: 'fixed',
      width: '18px',
      height: '18px',
      borderRadius: '50%',
      background: '#ff4d00',
      border: '2px solid white',
      boxShadow: '0 2px 8px rgb(0 0 0 / 35%)',
      zIndex: '2147483647',
      pointerEvents: 'none',
      transform: 'translate(-50%, -50%)',
      transition: 'left 80ms linear, top 80ms linear',
    });
    const caption = document.createElement('div');
    caption.dataset.deputiesCaption = '';
    Object.assign(caption.style, {
      position: 'fixed',
      left: '50%',
      bottom: '28px',
      maxWidth: '80%',
      padding: '10px 16px',
      borderRadius: '8px',
      color: 'white',
      background: 'rgb(15 23 42 / 88%)',
      font: '600 20px/1.3 system-ui, sans-serif',
      zIndex: '2147483646',
      pointerEvents: 'none',
      opacity: '0',
      transform: 'translateX(-50%)',
      transition: 'opacity 160ms ease',
    });
    document.documentElement.append(cursor, caption);
    document.addEventListener(
      'mousemove',
      (event) => {
        cursor.style.left = `${event.clientX}px`;
        cursor.style.top = `${event.clientY}px`;
      },
      true,
    );
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install);
  else install();
}

async function mediaDurationMs(filePath: string): Promise<number | undefined> {
  try {
    const stdout = await runCommand('ffprobe', [
      '-v',
      'error',
      '-show_entries',
      'format=duration',
      '-of',
      'default=noprint_wrappers=1:nokey=1',
      filePath,
    ]);
    const seconds = Number.parseFloat(stdout.trim());
    return Number.isFinite(seconds) ? Math.round(seconds * 1_000) : undefined;
  } catch {
    return undefined;
  }
}

function runCommand(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr.trim() || `${command} exited with code ${code ?? 'unknown'}`));
    });
  });
}
