import { stdin as input, stdout as output } from 'node:process';
import { createInterface } from 'node:readline/promises';
import { loginOpenAICodex, type OAuthAuthInfo, type OAuthPrompt } from '@earendil-works/pi-ai/oauth';
import {
  defaultOpenAICodexAuthFile,
  readOpenAICodexAuthFileIfPresent,
  writeOpenAICodexAuthFile,
} from './openai-codex-auth.js';

async function main(): Promise<void> {
  const authFile = process.env.OPENAI_CODEX_AUTH_FILE || defaultOpenAICodexAuthFile();
  const credentials = await loginOpenAICodex({
    originator: 'deputies',
    onAuth: printAuthInfo,
    onPrompt: question,
    onProgress: printProgress,
  });
  const auth = await readOpenAICodexAuthFileIfPresent(authFile);
  await writeOpenAICodexAuthFile(authFile, auth, credentials);
  output.write(`Saved OpenAI Codex OAuth credentials to ${authFile}\n`);
}

function printAuthInfo(info: OAuthAuthInfo): void {
  output.write(`Open this URL to authenticate OpenAI Codex:\n${info.url}\n`);
  if (info.instructions) output.write(`${info.instructions}\n`);
}

function printProgress(message: string): void {
  output.write(`${message}\n`);
}

async function question(prompt: OAuthPrompt): Promise<string> {
  const rl = createInterface({ input, output });
  try {
    while (true) {
      const answer = await rl.question(`${prompt.message} `);
      if (answer || prompt.allowEmpty) return answer;
    }
  } finally {
    rl.close();
  }
}

main().catch(function handleError(error: unknown): void {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
