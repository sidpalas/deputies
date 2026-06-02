#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const [, , modeOrCommand, ...args] = process.argv;
const scriptPath = fileURLToPath(import.meta.url);

if (modeOrCommand === '--write-env-file') {
  writeEnvFile(args[0], args[1]);
  process.exit(0);
}

if (!modeOrCommand) {
  console.error(`Usage: ${process.argv[1]} <command...>`);
  process.exit(1);
}

const scriptDir = dirname(scriptPath);
const rootDir = resolve(scriptDir, '../..');
const templatePath = join(rootDir, '.env.local');
const command = modeOrCommand;
const commandArgs = args;
let tempDir = '';

try {
  const env = { ...process.env };

  if (!env.DEPUTIES_ENV_FILE) {
    if (!existsSync(templatePath)) throw new Error(`Expected ${templatePath} to exist for env injection`);

    tempDir = mkdtempSync(join(tmpdir(), 'deputies-env-'));
    env.DEPUTIES_ENV_FILE = join(tempDir, 'env');

    await runChecked('op', [
      'run',
      '--env-file',
      templatePath,
      '--',
      process.execPath,
      scriptPath,
      '--write-env-file',
      templatePath,
      env.DEPUTIES_ENV_FILE,
    ]);
  }

  process.exitCode = await run(command, commandArgs, env);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
}

function writeEnvFile(templatePath, outputPath) {
  if (!templatePath || !outputPath) throw new Error('Usage: --write-env-file <template> <output>');

  const keys = envKeys(readFileSync(templatePath, 'utf8'));
  const output = keys.map((key) => `${key}=${quoteEnvValue(process.env[key] ?? '')}`).join('\n');
  writeFileSync(outputPath, `${output}\n`);
}

function envKeys(template) {
  const keys = [];
  const seen = new Set();

  for (const line of template.split(/\r?\n/)) {
    const match = line.trimStart().match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (!match || seen.has(match[1])) continue;
    keys.push(match[1]);
    seen.add(match[1]);
  }

  return keys;
}

function quoteEnvValue(value) {
  return `"${value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\$/g, () => '\\$')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')}"`;
}

function run(command, args, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: 'inherit' });

    child.on('error', (error) => {
      if (error.code === 'ENOENT') reject(new Error(`${command} not found`));
      else reject(error);
    });
    child.on('exit', (code, signal) => {
      if (signal) reject(new Error(`${command} exited with signal ${signal}`));
      else resolve(code ?? 1);
    });
  });
}

async function runChecked(command, args, env = process.env) {
  const code = await run(command, args, env);
  if (code !== 0) throw new Error(`${command} exited with status ${code}`);
}
