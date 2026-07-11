# Agent Browser Capture

This runbook explains how an agent verifies user-visible changes with screenshots and publishes a short browser demo video. Capture the app on `127.0.0.1` inside the sandbox; publishing the app as a service is not required.

## Check Capabilities

Use the recorder helper when it is installed:

```sh
command -v deputies-record
command -v ffmpeg
test -d "${PLAYWRIGHT_BROWSERS_PATH:-/ms-playwright}"
```

If Chromium is unavailable, do not fail the run over capture. Use any available screenshot mechanism or report that browser verification was unavailable. If system ffmpeg is absent, publish Playwright's WebM output directly.

## Start The App

Prefer built assets and a preview server over a dev server while recording. This avoids the long-running esbuild process being OOM-killed under sandbox memory pressure. Target the app's loopback URL directly.

## Verify Fonts

Font substitution changes text metrics and can make an otherwise correct page wrap or overflow differently from a user's browser. Before screenshots or recording, wait for the page's fonts and check for failed font requests:

```js
const failedFonts = [];
page.on('response', (response) => {
  if (response.request().resourceType() === 'font' && !response.ok()) {
    failedFonts.push(`${response.status()} ${response.url()}`);
  }
});

await page.goto('http://127.0.0.1:5173');
await page.evaluate(() => document.fonts.ready);
if (failedFonts.length) throw new Error(`Font requests failed:\n${failedFonts.join('\n')}`);
```

Also inspect a screenshot from the same context before recording. If a required font is absent or a remote font cannot be fetched, do not present the capture as pixel-accurate. Prefer repository-owned `@font-face` assets so local, CI, and sandbox rendering agree. When the application intentionally relies on a system font, install that font in the sandbox image and run `fc-cache -f` before capture.

## Record With The Helper

Create a scenario module that exports a default async function. It receives `page`, `caption`, and cursor-aware `click` and `hover` helpers:

```js
// /tmp/demo.mjs
export default async ({ page, caption, click }) => {
  await page.goto('http://127.0.0.1:5173');
  await page.evaluate(() => document.fonts.ready);
  await caption('Open the changed screen');
  await click(page.getByRole('button', { name: 'Continue' }));
  await page.getByRole('heading', { name: 'Complete' }).waitFor();
};
```

```sh
deputies-record /tmp/demo.mjs --output-dir /tmp/browser-demo
```

The command records one 1280x720 browser context by default, limits the scenario to 60 seconds, closes Chromium before transcoding, and prints JSON containing the unique final path, duration, size, format, resolved `viewport`, and `warnings`. It prefers MP4 and falls back to WebM if ffmpeg is unavailable or conversion fails. Scenarios may accept `signal` and pass it to their own network or subprocess work so the 60-second timeout cancels that work too.

Choose a viewport that matches the experience being demonstrated:

```bash
deputies-record /tmp/demo.mjs --preset desktop # 1440x900
deputies-record /tmp/demo.mjs --preset laptop  # 1280x720 (default)
deputies-record /tmp/demo.mjs --preset tablet  # 768x1024
deputies-record /tmp/demo.mjs --preset mobile  # 390x844
deputies-record /tmp/demo.mjs --width 1600 --height 1000
```

Use separate captures when validating multiple responsive breakpoints. Do not resize the page from inside a scenario because the recorded video dimensions remain fixed.

`warnings` is empty for a clean capture. It lists failed font requests and `FontFace` load errors when the browser may have substituted fallback fonts. Publish the artifact if it is still useful, but disclose every warning in the user-facing response and state that text wrapping and layout may differ from production. Do not call a warned capture pixel-accurate.

## Raw Playwright Fallback

When `deputies-record` is unavailable, use Playwright directly. Add an init script before opening the page so recordings show pointer movement:

```js
import { chromium } from 'playwright';

const browser = await chromium.launch({ channel: 'chromium' });
const context = await browser.newContext({
  viewport: { width: 1280, height: 720 },
  recordVideo: { dir: '/tmp/browser-video', size: { width: 1280, height: 720 } },
});
await context.addInitScript(() => {
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
      zIndex: '2147483647',
      pointerEvents: 'none',
      transform: 'translate(-50%, -50%)',
      transition: 'left 120ms, top 120ms',
    });
    document.documentElement.append(cursor);
    document.addEventListener(
      'mousemove',
      (event) => {
        cursor.style.left = `${event.clientX}px`;
        cursor.style.top = `${event.clientY}px`;
      },
      true,
    );
  };
  document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', install) : install();
});
const page = await context.newPage();
await page.goto('http://127.0.0.1:5173');
// Add the changed flow here. Keep the recording under 60 seconds.
await context.close();
await browser.close();
```

Move the mouse to each target before clicking so the overlay follows the action. Close the context and browser before transcoding.

```sh
ffmpeg -i input.webm -c:v libx264 -pix_fmt yuv420p -movflags +faststart output.mp4
```

## Verify And Publish

Take screenshots of every changed screen and use the sandbox `read` tool on each PNG. The visual read is required before claiming the UI is correct. Publish screenshots with `artifact type=screenshot` and demos with `artifact type=video`, using user-facing titles. Prefer MP4 (H.264/yuv420p), but WebM is accepted.

## Troubleshooting

- `Executable doesn't exist` under an `ffmpeg-*` Playwright cache path means the image lacks Playwright's helper binary. Rebuild with the browser-enabled Docker or Daytona image; system ffmpeg alone does not satisfy `recordVideo`.
- A missing `ffmpeg` command only prevents MP4 transcoding. Publish the WebM instead.
- If Chromium or the app is OOM-killed, stop dev servers, serve built assets, use one 1280x720 context, close Chromium before transcoding, and keep the recording short.
- Keep artifacts below the deployment's `ARTIFACT_CREATE_MAX_BYTES` limit, which defaults to 25 MB.
