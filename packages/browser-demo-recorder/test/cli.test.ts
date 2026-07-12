import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseArgs } from '../src/cli.js';

describe('parseArgs', () => {
  it('parses a scenario and output directory', () => {
    expect(parseArgs(['scenario.mjs', '--output-dir', 'captures'])).toEqual({
      scenarioPath: path.resolve('scenario.mjs'),
      outputDir: path.resolve('captures'),
      viewport: { width: 1440, height: 900 },
    });
  });

  it('parses viewport presets', () => {
    expect(parseArgs(['scenario.mjs', '--preset', 'mobile']).viewport).toEqual({ width: 390, height: 844 });
  });

  it('parses custom viewport dimensions', () => {
    expect(parseArgs(['scenario.mjs', '--width', '1600', '--height', '1000']).viewport).toEqual({
      width: 1600,
      height: 1000,
    });
  });

  for (const args of [
    [],
    ['one.mjs', 'two.mjs'],
    ['--unknown'],
    ['one.mjs', '--output-dir'],
    ['one.mjs', '--preset', 'watch'],
    ['one.mjs', '--width', '800'],
    ['one.mjs', '--preset', 'desktop', '--width', '800', '--height', '600'],
  ]) {
    it(`rejects invalid arguments: ${JSON.stringify(args)}`, () => {
      expect(() => parseArgs(args)).toThrow();
    });
  }
});
