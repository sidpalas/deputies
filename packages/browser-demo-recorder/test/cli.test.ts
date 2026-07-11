import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseArgs } from '../src/cli.js';

describe('parseArgs', () => {
  it('parses a scenario and output directory', () => {
    expect(parseArgs(['scenario.mjs', '--output-dir', 'captures'])).toEqual({
      scenarioPath: path.resolve('scenario.mjs'),
      outputDir: path.resolve('captures'),
    });
  });

  for (const args of [[], ['one.mjs', 'two.mjs'], ['--unknown'], ['one.mjs', '--output-dir']]) {
    it(`rejects invalid arguments: ${JSON.stringify(args)}`, () => {
      expect(() => parseArgs(args)).toThrow();
    });
  }
});
