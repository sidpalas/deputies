import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadScenario, recordScenario } from '../src/recorder.js';

const enabled = process.env.BROWSER_DEMO_RECORDER_SMOKE === '1';

describe.skipIf(!enabled)('browser demo recorder smoke', () => {
  it('records a data URL as a non-empty browser video', async () => {
    const outputDir = await mkdtemp(path.join(os.tmpdir(), 'deputies-recorder-smoke-'));
    try {
      const scenario = await loadScenario(path.resolve('test/fixtures/smoke-scenario.mjs'));
      const result = await recordScenario(scenario, outputDir);
      expect(result.path).toMatch(/browser-demo\.(mp4|webm)$/);
      expect(result.sizeBytes).toBeGreaterThan(0);
      expect(result.durationMs).toBeGreaterThan(0);
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });
});
