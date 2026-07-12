#!/usr/bin/env node
import path from 'node:path';
import { loadScenario, recordScenario, viewportPresets, type Viewport } from './recorder.js';

export type CliOptions = { scenarioPath: string; outputDir: string; viewport: Viewport };

export function parseArgs(args: string[]): CliOptions {
  let scenarioPath: string | undefined;
  let outputDir = path.resolve('browser-demo');
  let preset: keyof typeof viewportPresets | undefined;
  let width: number | undefined;
  let height: number | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === '--output-dir') {
      const value = args[index + 1];
      if (!value) throw new Error('--output-dir requires a path');
      outputDir = path.resolve(value);
      index += 1;
    } else if (argument === '--preset') {
      const value = args[index + 1] as keyof typeof viewportPresets | undefined;
      if (!value || !(value in viewportPresets)) {
        throw new Error(`--preset requires one of: ${Object.keys(viewportPresets).join(', ')}`);
      }
      preset = value;
      index += 1;
    } else if (argument === '--width' || argument === '--height') {
      const value = Number(args[index + 1]);
      if (!Number.isInteger(value) || value < 320 || value > 3840) {
        throw new Error(`${argument} requires an integer from 320 to 3840`);
      }
      if (argument === '--width') width = value;
      else height = value;
      index += 1;
    } else if (argument.startsWith('-')) {
      throw new Error(`unknown option: ${argument}`);
    } else if (scenarioPath) {
      throw new Error('provide exactly one scenario file');
    } else {
      scenarioPath = argument;
    }
  }
  if (!scenarioPath) {
    throw new Error(
      'usage: deputies-record <scenario.mjs> [--output-dir <directory>] [--preset <name> | --width <px> --height <px>]',
    );
  }
  if (preset && (width || height)) throw new Error('--preset cannot be combined with --width or --height');
  if ((width === undefined) !== (height === undefined))
    throw new Error('--width and --height must be provided together');
  const viewport = preset ? viewportPresets[preset] : width && height ? { width, height } : viewportPresets.laptop;
  return { scenarioPath: path.resolve(scenarioPath), outputDir, viewport };
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  const options = parseArgs(args);
  const scenario = await loadScenario(options.scenarioPath);
  const result = await recordScenario(scenario, options.outputDir, options.viewport);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && ['cli.js', 'deputies-record'].includes(path.basename(process.argv[1]))) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
