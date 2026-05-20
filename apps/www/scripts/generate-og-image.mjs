import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from '@playwright/test';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '../../..');
const outputPath = resolve(repoRoot, 'apps/www/public/og-image.png');

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });

await page.setContent(
  `<!doctype html>
  <html lang="en">
    <head>
      <meta charset="UTF-8" />
      <style>
        * { box-sizing: border-box; }
        body {
          margin: 0;
          width: 1200px;
          height: 630px;
          overflow: hidden;
          background:
            radial-gradient(circle at 18% 12%, rgba(96, 165, 250, 0.42), transparent 310px),
            radial-gradient(circle at 82% 78%, rgba(37, 99, 235, 0.34), transparent 360px),
            linear-gradient(135deg, #020617 0%, #0f172a 52%, #172554 100%);
          color: #f8fafc;
          font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        }
        .frame {
          position: relative;
          width: 100%;
          height: 100%;
          padding: 64px 72px;
        }
        .grid {
          position: absolute;
          inset: 0;
          background-image:
            linear-gradient(rgba(148, 163, 184, 0.08) 1px, transparent 1px),
            linear-gradient(90deg, rgba(148, 163, 184, 0.08) 1px, transparent 1px);
          background-size: 48px 48px;
          mask-image: linear-gradient(90deg, black, transparent 74%);
        }
        .brand {
          position: relative;
          z-index: 2;
          display: inline-flex;
          align-items: center;
          gap: 14px;
          color: #dbeafe;
          font-size: 28px;
          font-weight: 760;
          letter-spacing: -0.02em;
        }
        .mark {
          display: grid;
          width: 52px;
          height: 52px;
          place-items: center;
          border: 1px solid rgba(191, 219, 254, 0.38);
          border-radius: 14px;
          background: linear-gradient(135deg, #60a5fa, #2563eb);
          box-shadow: 0 18px 48px rgba(37, 99, 235, 0.36);
          color: white;
          font-size: 25px;
          font-weight: 830;
        }
        .copy {
          position: relative;
          z-index: 2;
          max-width: 560px;
          padding-top: 32px;
        }
        .eyebrow {
          margin: 0 0 18px;
          color: #93c5fd;
          font-size: 22px;
          font-weight: 760;
          letter-spacing: 0.08em;
          text-transform: uppercase;
        }
        h1 {
          max-width: 500px;
          margin: 0;
          font-size: 72px;
          line-height: 0.93;
          letter-spacing: -0.034em;
        }
        .lede {
          max-width: 425px;
          margin: 28px 0 0;
          color: #cbd5e1;
          font-size: 27px;
          line-height: 1.22;
          letter-spacing: -0.025em;
        }
        .pills {
          display: flex;
          gap: 12px;
          margin-top: 38px;
        }
        .pill {
          border: 1px solid rgba(191, 219, 254, 0.24);
          border-radius: 999px;
          padding: 10px 14px;
          background: rgba(15, 23, 42, 0.64);
          color: #bfdbfe;
          font-size: 17px;
          font-weight: 700;
        }
        .product {
          position: absolute;
          right: -14px;
          bottom: 52px;
          width: 686px;
          height: 488px;
          overflow: hidden;
          border: 1px solid rgba(147, 197, 253, 0.32);
          border-radius: 24px;
          background: #020617;
          box-shadow:
            0 36px 110px rgba(0, 0, 0, 0.52),
            0 0 72px rgba(59, 130, 246, 0.22);
          transform: none;
        }
        .browser-bar {
          display: flex;
          align-items: center;
          gap: 8px;
          height: 48px;
          border-bottom: 1px solid rgba(148, 163, 184, 0.18);
          padding: 0 18px;
          background: linear-gradient(180deg, rgba(30, 41, 59, 0.92), rgba(15, 23, 42, 0.92));
        }
        .browser-dot {
          width: 12px;
          height: 12px;
          border-radius: 999px;
          background: #334155;
        }
        .browser-dot:nth-child(1) { background: #fb7185; }
        .browser-dot:nth-child(2) { background: #facc15; }
        .browser-dot:nth-child(3) { background: #4ade80; }
        .app-shell {
          display: grid;
          height: 400px;
          grid-template-columns: 142px 1fr 146px;
          background: #020617;
        }
        .sidebar,
        .context {
          padding: 16px;
          background: #0f172a;
          color: #94a3b8;
        }
        .sidebar {
          border-right: 1px solid rgba(148, 163, 184, 0.18);
        }
        .context {
          border-left: 1px solid rgba(148, 163, 184, 0.18);
        }
        .label {
          margin-bottom: 12px;
          color: #e2e8f0;
          font-size: 14px;
          font-weight: 800;
        }
        .session-tab {
          border: 1px solid rgba(96, 165, 250, 0.55);
          border-radius: 10px;
          padding: 12px;
          background: rgba(37, 99, 235, 0.28);
          color: #dbeafe;
          font-size: 12px;
          font-weight: 780;
          line-height: 1.25;
        }
        .muted-line {
          height: 9px;
          margin-top: 12px;
          border-radius: 999px;
          background: rgba(148, 163, 184, 0.22);
        }
        .main-pane {
          padding: 18px 20px;
          background: #050816;
        }
        .session-title {
          margin: 0 0 14px;
          color: #f8fafc;
          font-size: 18px;
          font-weight: 820;
          letter-spacing: -0.03em;
        }
        .message,
        .response,
        .composer {
          border: 1px solid rgba(96, 165, 250, 0.34);
          border-radius: 12px;
          background: #0f172a;
          box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.04);
        }
        .message {
          padding: 14px;
          color: #e2e8f0;
          font-size: 14px;
          font-weight: 720;
        }
        .meta {
          display: flex;
          gap: 10px;
          margin-bottom: 10px;
          color: #94a3b8;
          font-size: 11px;
          font-weight: 760;
        }
        .complete { color: #34d399; }
        .response {
          margin-top: 10px;
          padding: 14px;
          color: #f8fafc;
          font-size: 13px;
          font-weight: 680;
          line-height: 1.5;
        }
        .code-chip {
          display: inline-block;
          border-radius: 6px;
          padding: 3px 7px;
          background: rgba(148, 163, 184, 0.2);
          color: #dbeafe;
          font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
          font-size: 12px;
        }
        .diagnostics {
          margin-top: 10px;
          border: 1px solid rgba(148, 163, 184, 0.16);
          border-radius: 10px;
          padding: 10px 12px;
          background: #07111f;
          color: #94a3b8;
          font-size: 12px;
          font-weight: 700;
        }
        .composer {
          margin-top: 12px;
          height: 82px;
          padding: 14px;
          color: #94a3b8;
          font-size: 14px;
          font-weight: 650;
        }
        .send-row {
          display: flex;
          justify-content: flex-end;
          margin-top: 10px;
        }
        .send-button {
          border-radius: 9px;
          padding: 9px 14px;
          background: #60a5fa;
          color: #082f49;
          font-size: 12px;
          font-weight: 820;
        }
        .context-card {
          border-top: 1px solid rgba(148, 163, 184, 0.18);
          padding: 14px 0;
          color: #cbd5e1;
          font-size: 12px;
          font-weight: 650;
        }
        .context-card:first-of-type { border-top: 0; padding-top: 0; }
        .context-card strong {
          display: block;
          margin-bottom: 6px;
          color: #f8fafc;
          font-size: 13px;
        }
        .status {
          position: absolute;
          left: 496px;
          bottom: 78px;
          z-index: 3;
          display: flex;
          align-items: center;
          gap: 10px;
          border: 1px solid rgba(74, 222, 128, 0.32);
          border-radius: 16px;
          padding: 12px 14px;
          background: rgba(2, 6, 23, 0.82);
          color: #dcfce7;
          box-shadow: 0 18px 54px rgba(0, 0, 0, 0.32);
          font-size: 18px;
          font-weight: 760;
          backdrop-filter: blur(12px);
        }
        .dot {
          width: 12px;
          height: 12px;
          border-radius: 999px;
          background: #22c55e;
          box-shadow: 0 0 18px rgba(34, 197, 94, 0.9);
        }
      </style>
    </head>
    <body>
      <main class="frame">
        <div class="grid"></div>
        <div class="brand"><span class="mark">D</span><span>Deputies</span></div>
        <section class="copy">
          <p class="eyebrow">Background agents</p>
          <h1>Delegate engineering work.</h1>
          <p class="lede">An open-source control plane for assigning, tracking, and reviewing async agent sessions.</p>
          <div class="pills">
            <span class="pill">Web UI</span>
            <span class="pill">Slack</span>
            <span class="pill">GitHub</span>
            <span class="pill">Webhooks</span>
          </div>
        </section>
        <figure class="product" aria-label="Representative Deputies session UI">
          <div class="browser-bar">
            <span class="browser-dot"></span><span class="browser-dot"></span><span class="browser-dot"></span>
          </div>
          <div class="app-shell">
            <aside class="sidebar">
              <div class="label">Sessions</div>
              <div class="session-tab">Fix flaky checkout test</div>
              <div class="muted-line"></div>
              <div class="muted-line" style="width: 72%"></div>
              <div class="muted-line" style="width: 84%"></div>
            </aside>
            <section class="main-pane">
              <h2 class="session-title">Run the failing tests and open a PR</h2>
              <div class="message">
                <div class="meta"><span>Message 1</span><span class="complete">completed</span></div>
                Find the regression, update the code, and summarize the fix.
              </div>
              <div class="response">
                Deputy response<br />
                Updated <span class="code-chip">checkout.test.ts</span>, verified the suite, and prepared a pull request.
              </div>
              <div class="diagnostics">Diagnostics · 25 events · 4 tool calls</div>
              <div class="composer">Ask your deputy to investigate, change code, or follow up...</div>
              <div class="send-row"><span class="send-button">Send message</span></div>
            </section>
            <aside class="context">
              <div class="context-card"><strong>Repository</strong>acme/app</div>
              <div class="context-card"><strong>Artifacts</strong>Patch, logs, preview</div>
              <div class="context-card"><strong>Callbacks</strong>GitHub PR ready</div>
            </aside>
          </div>
        </figure>
        <div class="status"><span class="dot"></span>Run completed</div>
      </main>
    </body>
  </html>`,
  { waitUntil: 'load' },
);

await page.screenshot({ path: outputPath, type: 'png' });
await browser.close();

console.log(`Generated ${outputPath}`);
