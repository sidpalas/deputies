import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AuthPrompt } from '@earendil-works/pi-ai';

export const openAICodexProvider = 'openai-codex';

export function defaultOpenAICodexAuthFile(): string {
  return join(homedir(), '.pi', 'agent', 'auth.json');
}

export type AuthQuestion = (message: string, options: { signal?: AbortSignal }) => Promise<string>;

export async function promptForOpenAICodexAuth(prompt: AuthPrompt, question: AuthQuestion): Promise<string> {
  if (prompt.type === 'select') {
    const choices = prompt.options
      .map((option, index) => `${index + 1}. ${option.label}${option.description ? ` — ${option.description}` : ''}`)
      .join('\n');
    while (true) {
      const answer = (
        await question(`${prompt.message}\n${choices}\nSelect 1-${prompt.options.length}: `, {
          ...(prompt.signal ? { signal: prompt.signal } : {}),
        })
      ).trim();
      const selected = prompt.options[Number(answer) - 1] ?? prompt.options.find((option) => option.id === answer);
      if (selected) return selected.id;
    }
  }

  switch (prompt.type) {
    case 'text':
    case 'secret':
    case 'manual_code':
      while (true) {
        const answer = (
          await question(`${prompt.message} `, { ...(prompt.signal ? { signal: prompt.signal } : {}) })
        ).trim();
        if (answer) return answer;
      }
  }
}
