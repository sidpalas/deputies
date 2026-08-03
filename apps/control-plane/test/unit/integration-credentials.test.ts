import { randomBytes, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  IntegrationCredentialCipher,
  parseIntegrationCredentialKeyring,
} from '../../src/integration-credentials/cipher.js';
import type { CredentialCodec } from '../../src/integration-credentials/postgres.js';
import {
  createPostgresCodexCredentialStore,
  PostgresCodexCredentialStore,
  type CodexCredentialRepository,
} from '../../src/runner-pi/postgres-credential-store.js';
import { openAICodexCredentialCodec, parseOpenAICodexSeed } from '../../src/runner/openai-codex-credentials.js';

const identity = {
  id: randomUUID(),
  scope: 'tenant' as const,
  namespace: 'model-provider',
  name: 'openai-codex',
  payloadSchema: 'pi.oauth',
  payloadVersion: 1,
};
const credential = { type: 'oauth' as const, access: 'access', refresh: 'refresh', expires: 123, accountId: 'account' };

describe('integration credential encryption', () => {
  it('authenticates ciphertext and every AAD identity field', () => {
    const cipher = new IntegrationCredentialCipher('current', new Map([['current', randomBytes(32)]]));
    const encrypted = cipher.encrypt(identity, openAICodexCredentialCodec.encode(credential));
    expect(openAICodexCredentialCodec.decode(cipher.decrypt(identity, encrypted))).toEqual(credential);
    expect(() => cipher.decrypt({ ...identity, name: 'other' }, encrypted)).toThrow('authentication failed');
    const tampered = { ...encrypted, ciphertext: Buffer.from(encrypted.ciphertext) };
    tampered.ciphertext[0]! ^= 1;
    expect(() => cipher.decrypt(identity, tampered)).toThrow('authentication failed');
  });

  it('reads historical keys and writes only with the active key', () => {
    const oldKey = randomBytes(32);
    const newKey = randomBytes(32);
    const oldCipher = new IntegrationCredentialCipher('old', new Map([['old', oldKey]]));
    const encrypted = oldCipher.encrypt(identity, Buffer.from('secret'));
    const rotated = new IntegrationCredentialCipher(
      'new',
      new Map([
        ['old', oldKey],
        ['new', newKey],
      ]),
    );
    expect(Buffer.from(rotated.decrypt(identity, encrypted)).toString()).toBe('secret');
    expect(rotated.encrypt(identity, Buffer.from('secret')).encryptionKeyId).toBe('new');
  });

  it('rejects malformed keyring configuration without including key values', () => {
    expect(() => parseIntegrationCredentialKeyring('key', JSON.stringify({ key: 'sensitive-invalid-value' }))).toThrow(
      'base64-encoded 32-byte keys',
    );
  });
});

describe('Pi Codex credential codec', () => {
  it('round trips only the exact pinned OAuth shape', () => {
    expect(openAICodexCredentialCodec.decode(openAICodexCredentialCodec.encode(credential))).toEqual(credential);
    expect(() => openAICodexCredentialCodec.encode({ ...credential, extra: true } as never)).toThrow('invalid');
    expect(() => openAICodexCredentialCodec.encode({ ...credential, expires: Number.NaN })).toThrow('invalid');
    expect(() => openAICodexCredentialCodec.encode({ ...credential, accountId: '' })).toThrow('fresh Codex login');
  });

  it('extracts only openai-codex from a base64 Pi auth seed', () => {
    const seed = Buffer.from(JSON.stringify({ 'openai-codex': credential, unrelated: { type: 'api_key' } })).toString(
      'base64',
    );
    expect(parseOpenAICodexSeed(seed)).toEqual(credential);
    expect(() => parseOpenAICodexSeed(`${seed}!`)).toThrow('invalid');
  });
});

describe('PostgresCodexCredentialStore', () => {
  function setup() {
    let durable = openAICodexCredentialCodec.encode(credential);
    const repository: CodexCredentialRepository = {
      read: async <T>(_key: unknown, codec: CredentialCodec<T>) => codec.decode(durable),
      modify: async <T>(
        _key: unknown,
        codec: CredentialCodec<T>,
        operation: (value: T | undefined) => Promise<T | undefined>,
      ) => {
        const current = codec.decode(durable);
        const replacement = await operation(current);
        if (replacement !== undefined) durable = codec.encode(replacement);
        return replacement ?? current;
      },
      delete: async () => {},
    };
    return {
      store: new PostgresCodexCredentialStore(repository),
      durable: () => openAICodexCredentialCodec.decode(durable),
    };
  }

  it('reads and lists only safe OpenAI Codex metadata', async () => {
    const { store } = setup();
    await expect(store.read('openai-codex')).resolves.toEqual(credential);
    await expect(store.read('anthropic')).resolves.toBeUndefined();
    await expect(store.list()).resolves.toEqual([{ providerId: 'openai-codex', type: 'oauth' }]);
  });

  it('rejects unrelated providers and invalid candidates', async () => {
    const { store } = setup();
    expect(() => store.modify('anthropic', async () => credential)).toThrow('does not support provider');
    await expect(store.modify('openai-codex', async () => ({ type: 'api_key', key: 'secret' }))).rejects.toThrow(
      'invalid',
    );
    await expect(store.delete('openai-codex')).rejects.toThrow('explicit reconnect workflow');
  });

  it('allows an empty PostgreSQL store when Codex has not been configured', async () => {
    const repository: CodexCredentialRepository = {
      read: async () => undefined,
      modify: async (_key, _codec, operation) => operation(undefined),
      delete: async () => {},
    };
    const store = await createPostgresCodexCredentialStore(repository);
    await expect(store.read('openai-codex')).resolves.toBeUndefined();
    await expect(store.list()).resolves.toEqual([]);
  });

  it('leaves the durable credential unchanged when a callback fails', async () => {
    const { store, durable } = setup();
    await expect(
      store.modify('openai-codex', async () => Promise.reject(new Error('provider failed'))),
    ).rejects.toThrow('provider failed');
    expect(durable()).toEqual(credential);
  });

  it('does not return a candidate before persistence and rejects without publishing it', async () => {
    let releasePersistence!: () => void;
    const gate = new Promise<void>((resolve) => {
      releasePersistence = resolve;
    });
    const replacement = { ...credential, access: 'candidate' };
    const repository: CodexCredentialRepository = {
      read: async (_key, codec) => codec.decode(openAICodexCredentialCodec.encode(credential)),
      modify: async (_key, codec, operation) => {
        await operation(codec.decode(openAICodexCredentialCodec.encode(credential)));
        await gate;
        throw new Error('persistence rejected');
      },
      delete: async () => {},
    };
    const store = new PostgresCodexCredentialStore(repository);
    let settled = false;
    const result = store
      .modify('openai-codex', async () => replacement)
      .finally(() => {
        settled = true;
      });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(settled).toBe(false);
    releasePersistence();
    await expect(result).rejects.toThrow('persistence rejected');
  });
});
