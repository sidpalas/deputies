import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadScenario } from '../src/recorder.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('loadScenario', () => {
  it('loads a default scenario function', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'deputies-recorder-'));
    temporaryDirectories.push(directory);
    const scenarioPath = path.join(directory, 'scenario.mjs');
    await writeFile(scenarioPath, 'export default async () => {};\n');
    await expect(loadScenario(scenarioPath)).resolves.toEqual(expect.any(Function));
  });

  it('rejects a module without a default function', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'deputies-recorder-'));
    temporaryDirectories.push(directory);
    const scenarioPath = path.join(directory, 'scenario.mjs');
    await writeFile(scenarioPath, 'export const scenario = true;\n');
    await expect(loadScenario(scenarioPath)).rejects.toThrow('default async function');
  });
});
