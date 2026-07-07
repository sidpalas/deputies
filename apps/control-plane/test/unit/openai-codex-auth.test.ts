import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadOpenAICodexApiKey } from '../../src/runner/openai-codex-auth.js';

describe('loadOpenAICodexApiKey', () => {
  it('loads Codex OAuth credentials from a Pi auth file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'deputies-codex-auth-'));
    const authFile = join(dir, 'auth.json');
    await writeFile(
      authFile,
      JSON.stringify({
        'openai-codex': {
          type: 'oauth',
          access: 'codex-access-token',
          refresh: 'codex-refresh-token',
          expires: Date.now() + 60_000,
        },
      }),
    );

    try {
      await expect(loadOpenAICodexApiKey(authFile)).resolves.toEqual({
        apiKey: 'codex-access-token',
        authFile,
      });
      await expect(readFile(authFile, 'utf8')).resolves.toContain('"type": "oauth"');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('fails clearly when the Pi auth file has no Codex credentials', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'deputies-codex-auth-'));
    const authFile = join(dir, 'auth.json');
    await writeFile(authFile, '{}');

    try {
      await expect(loadOpenAICodexApiKey(authFile)).rejects.toThrow('Missing openai-codex OAuth credentials');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('loads Codex OAuth credentials from an environment base64 value', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'deputies-codex-auth-'));
    const authFile = join(dir, 'auth.json');
    const authBase64 = Buffer.from(
      JSON.stringify({
        'openai-codex': {
          type: 'oauth',
          access: 'codex-access-token',
          refresh: 'codex-refresh-token',
          expires: Date.now() + 60_000,
        },
      }),
    ).toString('base64');

    try {
      await expect(loadOpenAICodexApiKey({ authFile, authBase64 })).resolves.toEqual({
        apiKey: 'codex-access-token',
        authFile,
      });
      await expect(readFile(authFile, 'utf8')).resolves.toContain('"type": "oauth"');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
