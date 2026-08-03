import { stdin as input, stdout as output } from 'node:process';
import { createInterface } from 'node:readline/promises';
import type { AuthEvent, AuthPrompt } from '@earendil-works/pi-ai';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { defaultOpenAICodexAuthFile, openAICodexProvider, promptForOpenAICodexAuth } from './openai-codex-auth.js';

async function main(): Promise<void> {
  const authFile = process.env.OPENAI_CODEX_AUTH_FILE || defaultOpenAICodexAuthFile();
  const runtime = await ModelRuntime.create({ authPath: authFile });
  await runtime.login(openAICodexProvider, 'oauth', {
    prompt: question,
    notify: printAuthEvent,
  });
  output.write(`Saved OpenAI Codex OAuth credentials to ${authFile}\n`);
}

function printAuthEvent(event: AuthEvent): void {
  if (event.type === 'auth_url') {
    output.write(`Open this URL to authenticate OpenAI Codex:\n${event.url}\n`);
    if (event.instructions) output.write(`${event.instructions}\n`);
  } else if (event.type === 'progress' || event.type === 'info') output.write(`${event.message}\n`);
  else output.write(`Open ${event.verificationUri} and enter code ${event.userCode}\n`);
}

async function question(prompt: AuthPrompt): Promise<string> {
  const rl = createInterface({ input, output });
  try {
    return await promptForOpenAICodexAuth(prompt, (message, options) => rl.question(message, options));
  } finally {
    rl.close();
  }
}

main().catch(function handleError(error: unknown): void {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
