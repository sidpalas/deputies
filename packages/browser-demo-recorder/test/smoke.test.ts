import { mkdtemp, readdir, rm } from 'node:fs/promises';
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
      const results = await Promise.all([recordScenario(scenario, outputDir), recordScenario(scenario, outputDir)]);
      expect(results[0]?.path).not.toBe(results[1]?.path);
      for (const result of results) {
        expect(result.path).toMatch(/browser-demo-[0-9a-f-]+\.(mp4|webm)$/);
        expect(result.sizeBytes).toBeGreaterThan(0);
        expect(result.durationMs).toBeGreaterThan(0);
        expect(result.viewport).toEqual({ width: 1280, height: 720 });
        expect(result.warnings).toEqual([]);
      }
      const files = await readdir(outputDir);
      expect(files.filter((file) => file.endsWith('.webm'))).toHaveLength(
        results.filter((result) => result.format === 'webm').length,
      );
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  }, 120_000);

  it('reports font loading failures', async () => {
    const outputDir = await mkdtemp(path.join(os.tmpdir(), 'deputies-recorder-font-smoke-'));
    try {
      const scenario = await loadScenario(path.resolve('test/fixtures/missing-font-scenario.mjs'));
      const result = await recordScenario(scenario, outputDir);
      expect(result.warnings).toEqual([expect.stringContaining('Font request failed')]);
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  }, 120_000);
});
