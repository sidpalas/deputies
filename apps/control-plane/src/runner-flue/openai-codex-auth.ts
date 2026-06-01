import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { getOAuthApiKey, type OAuthCredentials } from '@earendil-works/pi-ai/oauth';

export const openAICodexProvider = 'openai-codex';

export type OpenAICodexAuthResult = {
  apiKey: string;
  authFile: string;
};

export type OpenAICodexAuthOptions = {
  authFile?: string;
  authBase64?: string;
};

export async function loadOpenAICodexApiKey(
  options: OpenAICodexAuthOptions | string = {},
): Promise<OpenAICodexAuthResult> {
  const { authFile = defaultOpenAICodexAuthFile(), authBase64 } =
    typeof options === 'string' ? { authFile: options } : options;
  const auth = authBase64
    ? parseAuthFile(Buffer.from(authBase64, 'base64').toString('utf8'), 'OPENAI_CODEX_AUTH_BASE64')
    : await readAuthFile(authFile);
  const result = await getOAuthApiKey(openAICodexProvider, auth as Record<string, OAuthCredentials>);
  if (!result) {
    const source = authBase64 ? 'OPENAI_CODEX_AUTH_BASE64' : authFile;
    throw new Error(
      `Missing ${openAICodexProvider} OAuth credentials in ${source}. Run pnpm --dir apps/control-plane auth:login:openai-codex first.`,
    );
  }

  await writeOpenAICodexAuthFile(authFile, auth, result.newCredentials);

  return { apiKey: result.apiKey, authFile };
}

export function defaultOpenAICodexAuthFile(): string {
  return join(homedir(), '.pi', 'agent', 'auth.json');
}

export async function readOpenAICodexAuthFileIfPresent(authFile: string): Promise<Record<string, unknown>> {
  try {
    return parseAuthFile(await readFile(authFile, 'utf8'), authFile);
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return {};
    throw error;
  }
}

export async function writeOpenAICodexAuthFile(
  authFile: string,
  auth: Record<string, unknown>,
  credentials: OAuthCredentials,
): Promise<void> {
  auth[openAICodexProvider] = { type: 'oauth', ...credentials };
  await mkdir(dirname(authFile), { recursive: true });
  await writeFile(authFile, `${JSON.stringify(auth, null, 2)}\n`, { mode: 0o600 });
  await chmod(authFile, 0o600);
}

async function readAuthFile(authFile: string): Promise<Record<string, unknown>> {
  try {
    return parseAuthFile(await readFile(authFile, 'utf8'), authFile);
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      throw new Error(
        `Pi auth file not found at ${authFile}. Run pnpm --dir apps/control-plane auth:login:openai-codex first.`,
      );
    }
    throw error;
  }
}

function parseAuthFile(content: string, authFile: string): Record<string, unknown> {
  try {
    return JSON.parse(content) as Record<string, unknown>;
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`Invalid Pi auth file JSON at ${authFile}`);
    throw error;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
