#!/usr/bin/env node
import path from 'node:path';
import { loadScenario, recordScenario } from './recorder.js';

export type CliOptions = { scenarioPath: string; outputDir: string };

export function parseArgs(args: string[]): CliOptions {
  let scenarioPath: string | undefined;
  let outputDir = path.resolve('browser-demo');
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === '--output-dir') {
      const value = args[index + 1];
      if (!value) throw new Error('--output-dir requires a path');
      outputDir = path.resolve(value);
      index += 1;
    } else if (argument.startsWith('-')) {
      throw new Error(`unknown option: ${argument}`);
    } else if (scenarioPath) {
      throw new Error('provide exactly one scenario file');
    } else {
      scenarioPath = argument;
    }
  }
  if (!scenarioPath) throw new Error('usage: deputies-record <scenario.mjs> [--output-dir <directory>]');
  return { scenarioPath: path.resolve(scenarioPath), outputDir };
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  const options = parseArgs(args);
  const scenario = await loadScenario(options.scenarioPath);
  const result = await recordScenario(scenario, options.outputDir);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && ['cli.js', 'deputies-record'].includes(path.basename(process.argv[1]))) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
