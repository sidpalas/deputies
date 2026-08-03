import { Pool, type PoolClient } from 'pg';
import { IntegrationCredentialCipher } from '../../src/integration-credentials/cipher.js';
import {
  PostgresIntegrationCredentialRepository,
  type CredentialKey,
} from '../../src/integration-credentials/postgres.js';
import { PostgresCodexCredentialStore } from '../../src/runner-pi/postgres-credential-store.js';
import { openAICodexCredentialCodec, type PiOAuthCredentialV1 } from '../../src/runner/openai-codex-credentials.js';
import { setupPostgresStoreSuite, testDatabaseUrl } from '../support/postgres-store-suite.js';

const key: CredentialKey = { scope: 'tenant', namespace: 'model-provider', name: 'openai-codex' };
const oldKey = Buffer.alloc(32, 11);
const newKey = Buffer.alloc(32, 22);
const credential = (suffix: string, expires = Date.now() + 60_000): PiOAuthCredentialV1 => ({
  type: 'oauth',
  access: `access-${suffix}`,
  refresh: `refresh-${suffix}`,
  expires,
  accountId: `account-${suffix}`,
});

async function seed(
  repository: PostgresIntegrationCredentialRepository,
  value: PiOAuthCredentialV1,
): Promise<PiOAuthCredentialV1> {
  return (await repository.modify(key, openAICodexCredentialCodec, async (current) =>
    current === undefined ? value : undefined,
  ))!;
}

async function keyCounts(pool: Pool): Promise<Map<string, number>> {
  const result = await pool.query<{ encryption_key_id: string; count: string }>(
    'SELECT encryption_key_id,count(*) FROM integration_credentials GROUP BY encryption_key_id',
  );
  return new Map(result.rows.map((row) => [row.encryption_key_id, Number(row.count)]));
}

describe.skipIf(!testDatabaseUrl)('PostgresIntegrationCredentialRepository', () => {
  let databaseUrl: string;
  let pool: Pool;
  setupPostgresStoreSuite('integration_credentials', (context) => {
    databaseUrl = context.databaseUrl;
    pool = context.pool;
  });

  it('converges concurrent seeds, encrypts values, persists rotations, deletes, and counts key IDs', async () => {
    const cipher = new IntegrationCredentialCipher('old', new Map([['old', oldKey]]));
    const first = new PostgresIntegrationCredentialRepository(databaseUrl, cipher);
    const second = new PostgresIntegrationCredentialRepository(databaseUrl, cipher);
    try {
      const [a, b] = await Promise.all([seed(first, credential('seed-a')), seed(second, credential('seed-b'))]);
      expect(a).toEqual(b);
      expect(await seed(first, credential('loser'))).toEqual(a);
      const raw = await pool.query<{ ciphertext: Buffer }>('SELECT ciphertext FROM integration_credentials');
      expect(raw.rows[0]!.ciphertext.toString('utf8')).not.toContain(a.access);
      expect(await keyCounts(pool)).toEqual(new Map([['old', 1]]));

      const rotated = credential('rotated');
      await first.modify(key, openAICodexCredentialCodec, async () => rotated);
      const restarted = new PostgresIntegrationCredentialRepository(databaseUrl, cipher);
      try {
        await expect(restarted.read(key, openAICodexCredentialCodec)).resolves.toEqual(rotated);
      } finally {
        await restarted.close();
      }
      await first.delete(key);
      await expect(second.read(key, openAICodexCredentialCodec)).resolves.toBeUndefined();
    } finally {
      await Promise.all([first.close(), second.close()]);
    }
  });

  it('reads with an old key and writes with the active new key', async () => {
    const oldCredential = credential('old');
    const oldRepository = new PostgresIntegrationCredentialRepository(
      databaseUrl,
      new IntegrationCredentialCipher('old', new Map([['old', oldKey]])),
    );
    await seed(oldRepository, oldCredential);
    await oldRepository.close();
    const rotated = new PostgresIntegrationCredentialRepository(
      databaseUrl,
      new IntegrationCredentialCipher(
        'new',
        new Map([
          ['old', oldKey],
          ['new', newKey],
        ]),
      ),
    );
    try {
      await expect(rotated.read(key, openAICodexCredentialCodec)).resolves.toEqual(oldCredential);
      await rotated.modify(key, openAICodexCredentialCodec, async (current) => current);
      expect(await keyCounts(pool)).toEqual(new Map([['new', 1]]));
    } finally {
      await rotated.close();
    }
  });

  it.each(['ciphertext', 'aad'] as const)('fails closed when %s is tampered', async (kind) => {
    const repository = new PostgresIntegrationCredentialRepository(
      databaseUrl,
      new IntegrationCredentialCipher('old', new Map([['old', oldKey]])),
    );
    try {
      await seed(repository, credential('tamper'));
      if (kind === 'ciphertext')
        await pool.query(
          'UPDATE integration_credentials SET ciphertext=set_byte(ciphertext,0,get_byte(ciphertext,0)#1)',
        );
      else await pool.query("UPDATE integration_credentials SET namespace='tampered'");
      const readKey = kind === 'aad' ? { ...key, namespace: 'tampered' } : key;
      await expect(repository.read(readKey, openAICodexCredentialCodec)).rejects.toThrow('authentication failed');
    } finally {
      await repository.close();
    }
  });

  it('serializes Pi-compatible refreshes across replicas and persists the complete replacement', async () => {
    const cipher = new IntegrationCredentialCipher('old', new Map([['old', oldKey]]));
    const repoA = new PostgresIntegrationCredentialRepository(databaseUrl, cipher);
    const repoB = new PostgresIntegrationCredentialRepository(databaseUrl, cipher);
    const expired = credential('expired', Date.now() - 1);
    await seed(repoA, expired);
    const storeA = new PostgresCodexCredentialStore(repoA);
    const storeB = new PostgresCodexCredentialStore(repoB);
    let providerCount = 0;
    const refreshed = credential('committed', Date.now() + 60_000);
    const callback = async (auth: import('@earendil-works/pi-ai').Credential | undefined) => {
      if (!auth || auth.type !== 'oauth') throw new Error('missing credential');
      if (Date.now() < auth.expires) return undefined;
      providerCount += 1;
      return refreshed;
    };
    try {
      const results = await Promise.all([
        storeA.modify('openai-codex', callback),
        storeB.modify('openai-codex', callback),
      ]);
      expect(providerCount).toBe(1);
      expect(results).toEqual([refreshed, refreshed]);
      await expect(repoA.read(key, openAICodexCredentialCodec)).resolves.toEqual(refreshed);
      const restarted = new PostgresIntegrationCredentialRepository(databaseUrl, cipher);
      try {
        const store = new PostgresCodexCredentialStore(restarted);
        await expect(store.read('openai-codex')).resolves.toEqual(refreshed);
      } finally {
        await restarted.close();
      }
    } finally {
      await Promise.all([repoA.close(), repoB.close()]);
    }
  });

  it.each(['before-commit', 'after-commit'] as const)(
    'recovers a rotated credential after a transient %s write failure without repeating the provider callback',
    async (failure) => {
      const repository = new PostgresIntegrationCredentialRepository(
        databaseUrl,
        new IntegrationCredentialCipher('old', new Map([['old', oldKey]])),
      );
      const expired = credential('recovery-expired', Date.now() - 1);
      const replacement = credential('recovery-committed');
      await seed(repository, expired);
      const restoreConnect = injectOneUpdateFailure(repository, failure);
      let providerCount = 0;
      try {
        await expect(
          repository.modify(key, openAICodexCredentialCodec, async (current) => {
            expect(current).toEqual(expired);
            providerCount += 1;
            return replacement;
          }),
        ).resolves.toEqual(replacement);
        restoreConnect();
        expect(providerCount).toBe(1);
        await expect(repository.read(key, openAICodexCredentialCodec)).resolves.toEqual(replacement);
      } finally {
        restoreConnect();
        await repository.close();
      }
    },
  );

  it.each(['before-commit', 'after-commit'] as const)(
    'recovers a transient %s fence-establishment failure without invoking the provider callback',
    async (failure) => {
      const cipher = new IntegrationCredentialCipher('old', new Map([['old', oldKey]]));
      const repository = new PostgresIntegrationCredentialRepository(databaseUrl, cipher);
      const contender = new PostgresIntegrationCredentialRepository(databaseUrl, cipher);
      const original = credential(`fence-${failure}`, Date.now() - 1);
      await seed(repository, original);
      const restoreConnect = injectOneUpdateFailure(repository, failure, undefined, 'FENCE');
      let providerCount = 0;
      try {
        await expect(
          repository.modify(key, openAICodexCredentialCodec, async () => {
            providerCount += 1;
            return credential('must-not-run');
          }),
        ).rejects.toThrow('did not start');
        restoreConnect();
        expect(providerCount).toBe(0);
        const fence = await pool.query<{ pending_operation_id: string | null }>(
          'SELECT pending_operation_id FROM integration_credentials',
        );
        expect(fence.rows[0]!.pending_operation_id).toBeNull();
        await expect(contender.modify(key, openAICodexCredentialCodec, async () => undefined)).resolves.toEqual(
          original,
        );
      } finally {
        restoreConnect();
        await Promise.all([repository.close(), contender.close()]);
      }
    },
  );

  it.each(['before-commit', 'after-commit'] as const)(
    'recovers a transient %s fence-clear failure without changing the credential revision',
    async (failure) => {
      const repository = new PostgresIntegrationCredentialRepository(
        databaseUrl,
        new IntegrationCredentialCipher('old', new Map([['old', oldKey]])),
      );
      const original = credential(`clear-${failure}`);
      await seed(repository, original);
      const restoreConnect = injectOneUpdateFailure(repository, failure, undefined, 'CLEAR');
      try {
        await expect(repository.modify(key, openAICodexCredentialCodec, async () => undefined)).resolves.toEqual(
          original,
        );
        restoreConnect();
        const row = await pool.query<{ pending_operation_id: string | null; revision: string }>(
          'SELECT pending_operation_id,revision FROM integration_credentials',
        );
        expect(row.rows[0]).toEqual({ pending_operation_id: null, revision: '1' });
      } finally {
        restoreConnect();
        await repository.close();
      }
    },
  );

  it('prevents a waiting replica from replaying a refresh during ambiguous-write recovery', async () => {
    const cipher = new IntegrationCredentialCipher('old', new Map([['old', oldKey]]));
    const repoA = new PostgresIntegrationCredentialRepository(databaseUrl, cipher);
    const repoB = new PostgresIntegrationCredentialRepository(databaseUrl, cipher);
    const expired = credential('fenced-expired', Date.now() - 1);
    const replacement = credential('fenced-replacement');
    await seed(repoA, expired);
    let providerCount = 0;
    const callback = async (current: PiOAuthCredentialV1 | undefined) => {
      if (!current) throw new Error('missing credential');
      if (Date.now() < current.expires) return undefined;
      providerCount += 1;
      return replacement;
    };
    let waiting: Promise<PiOAuthCredentialV1 | undefined> | undefined;
    const restoreConnect = injectOneUpdateFailure(repoA, 'before-commit', async () => {
      waiting = repoB.modify(key, openAICodexCredentialCodec, callback);
      void waiting.catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 100));
    });
    try {
      await expect(repoA.modify(key, openAICodexCredentialCodec, callback)).resolves.toEqual(replacement);
      if (!waiting) throw new Error('Contending credential operation did not start');
      const contender = await Promise.allSettled([waiting]);
      if (contender[0].status === 'fulfilled') expect(contender[0].value).toEqual(replacement);
      else
        expect(contender[0].reason).toEqual(expect.objectContaining({ message: expect.stringMatching(/reconnect/) }));
      expect(providerCount).toBe(1);
      await expect(repoA.read(key, openAICodexCredentialCodec)).resolves.toEqual(replacement);
    } finally {
      restoreConnect();
      await Promise.all([repoA.close(), repoB.close()]);
    }
  });

  it('fails closed after a callback with an uncertain provider outcome', async () => {
    const cipher = new IntegrationCredentialCipher('old', new Map([['old', oldKey]]));
    const repository = new PostgresIntegrationCredentialRepository(databaseUrl, cipher);
    const contender = new PostgresIntegrationCredentialRepository(databaseUrl, cipher);
    await seed(repository, credential('uncertain', Date.now() - 1));
    let contenderCallbacks = 0;
    try {
      await expect(
        repository.modify(key, openAICodexCredentialCodec, async () => {
          throw new Error('response was lost');
        }),
      ).rejects.toThrow('outcome is uncertain');
      await expect(
        contender.modify(key, openAICodexCredentialCodec, async () => {
          contenderCallbacks += 1;
          return credential('must-not-refresh');
        }),
      ).rejects.toThrow('reconnect');
      expect(contenderCallbacks).toBe(0);
      const fence = await pool.query<{ pending_operation_id: string | null }>(
        'SELECT pending_operation_id FROM integration_credentials',
      );
      expect(fence.rows[0]!.pending_operation_id).not.toBeNull();
    } finally {
      await Promise.all([repository.close(), contender.close()]);
    }
  });

  it('fails closed when a credential changes but retains this operation fence during recovery', async () => {
    const cipher = new IntegrationCredentialCipher('old', new Map([['old', oldKey]]));
    const repository = new PostgresIntegrationCredentialRepository(databaseUrl, cipher);
    const expired = credential('superseded-expired', Date.now() - 1);
    const candidate = credential('superseded-candidate');
    const authoritative = credential('authoritative');
    await seed(repository, expired);
    const restoreConnect = injectOneUpdateFailure(repository, 'before-commit', async () => {
      const row = (
        await pool.query<{ id: string }>(
          'SELECT id FROM integration_credentials WHERE scope=$1 AND namespace=$2 AND name=$3',
          [key.scope, key.namespace, key.name],
        )
      ).rows[0]!;
      const encrypted = cipher.encrypt(
        {
          id: row.id,
          ...key,
          payloadSchema: openAICodexCredentialCodec.schema,
          payloadVersion: openAICodexCredentialCodec.version,
        },
        openAICodexCredentialCodec.encode(authoritative),
      );
      await pool.query(
        `UPDATE integration_credentials
         SET encryption_key_id=$2,nonce=$3,ciphertext=$4,auth_tag=$5,revision=revision+1
         WHERE id=$1`,
        [row.id, encrypted.encryptionKeyId, encrypted.nonce, encrypted.ciphertext, encrypted.authTag],
      );
    });
    let providerCount = 0;
    try {
      await expect(
        repository.modify(key, openAICodexCredentialCodec, async () => {
          providerCount += 1;
          return candidate;
        }),
      ).rejects.toThrow('could not be safely recovered');
      restoreConnect();
      expect(providerCount).toBe(1);
      await expect(repository.read(key, openAICodexCredentialCodec)).rejects.toThrow('reconnect');
      const fence = await pool.query<{ pending_operation_id: string | null }>(
        'SELECT pending_operation_id FROM integration_credentials',
      );
      expect(fence.rows[0]!.pending_operation_id).not.toBeNull();
    } finally {
      restoreConnect();
      await repository.close();
    }
  });

  it('fails recovery without recreating a credential deleted after provider success', async () => {
    const repository = new PostgresIntegrationCredentialRepository(
      databaseUrl,
      new IntegrationCredentialCipher('old', new Map([['old', oldKey]])),
    );
    const expired = credential('deleted-expired', Date.now() - 1);
    await seed(repository, expired);
    const restoreConnect = injectOneUpdateFailure(repository, 'before-commit', async () => {
      await pool.query('DELETE FROM integration_credentials WHERE scope=$1 AND namespace=$2 AND name=$3', [
        key.scope,
        key.namespace,
        key.name,
      ]);
    });
    let providerCount = 0;
    try {
      await expect(
        repository.modify(key, openAICodexCredentialCodec, async () => {
          providerCount += 1;
          return credential('must-not-reappear');
        }),
      ).rejects.toThrow('could not be safely recovered');
      restoreConnect();
      expect(providerCount).toBe(1);
      await expect(repository.read(key, openAICodexCredentialCodec)).resolves.toBeUndefined();
    } finally {
      restoreConnect();
      await repository.close();
    }
  });

  it('does not resurrect a deleted credential after an ambiguous insert', async () => {
    const repository = new PostgresIntegrationCredentialRepository(
      databaseUrl,
      new IntegrationCredentialCipher('old', new Map([['old', oldKey]])),
    );
    const restoreConnect = injectOneUpdateFailure(
      repository,
      'after-commit',
      async () => {
        await pool.query('DELETE FROM integration_credentials WHERE scope=$1 AND namespace=$2 AND name=$3', [
          key.scope,
          key.namespace,
          key.name,
        ]);
      },
      'INSERT',
    );
    try {
      await expect(
        repository.modify(key, openAICodexCredentialCodec, async () => credential('must-not-be-resurrected')),
      ).rejects.toThrow('could not be safely recovered');
      restoreConnect();
      await expect(repository.read(key, openAICodexCredentialCodec)).resolves.toBeUndefined();
    } finally {
      restoreConnect();
      await repository.close();
    }
  });

  it('bounds stalled credential queries and releases their advisory locks', async () => {
    const cipher = new IntegrationCredentialCipher('old', new Map([['old', oldKey]]));
    const repository = new PostgresIntegrationCredentialRepository(databaseUrl, cipher, 100);
    const contender = new PostgresIntegrationCredentialRepository(databaseUrl, cipher, 100);
    const original = credential('query-timeout');
    await seed(repository, original);
    const restoreConnect = injectOneReadDelay(repository);
    try {
      const startedAt = Date.now();
      await expect(repository.modify(key, openAICodexCredentialCodec, async () => undefined)).rejects.toThrow(
        'connection state is uncertain',
      );
      expect(Date.now() - startedAt).toBeLessThan(1_000);
      await expect(contender.modify(key, openAICodexCredentialCodec, async () => undefined)).resolves.toEqual(original);
    } finally {
      restoreConnect();
      await Promise.all([repository.close(), contender.close()]);
    }
  });
});

function injectOneUpdateFailure(
  repository: PostgresIntegrationCredentialRepository,
  failure: 'before-commit' | 'after-commit',
  onFailure?: () => Promise<void>,
  statement: 'INSERT' | 'UPDATE' | 'FENCE' | 'CLEAR' = 'UPDATE',
): () => void {
  const internalPool = (repository as unknown as { pool: Pool }).pool;
  const connect = internalPool.connect.bind(internalPool);
  let pending = true;
  internalPool.connect = async () => {
    const client = await connect();
    const originalQuery = client.query;
    const query = client.query.bind(client) as (sql: string, values?: unknown[]) => Promise<unknown>;
    client.query = (async (...args: Parameters<PoolClient['query']>): Promise<unknown> => {
      const sql = args[0];
      if (typeof sql !== 'string') throw new Error('Expected a text query in credential fault injection');
      const values = args[1] as unknown[] | undefined;
      const matches =
        (statement === 'INSERT' && sql.startsWith('INSERT INTO integration_credentials')) ||
        (statement === 'UPDATE' && sql.startsWith('UPDATE integration_credentials SET encryption_version')) ||
        (statement === 'FENCE' && sql.includes('SET pending_operation_id=$3')) ||
        (statement === 'CLEAR' && sql.includes('SET pending_operation_id=NULL'));
      if (pending && matches) {
        pending = false;
        internalPool.connect = connect;
        client.query = originalQuery;
        if (failure === 'after-commit') await query(sql, values);
        if (onFailure) await onFailure();
        throw new Error('injected connection loss');
      }
      return query(sql, values);
    }) as PoolClient['query'];
    return client;
  };
  return () => {
    internalPool.connect = connect;
  };
}

function injectOneReadDelay(repository: PostgresIntegrationCredentialRepository): () => void {
  const internalPool = (repository as unknown as { pool: Pool }).pool;
  const connect = internalPool.connect.bind(internalPool);
  let pending = true;
  internalPool.connect = async () => {
    const client = await connect();
    const originalQuery = client.query;
    const query = client.query.bind(client) as (sql: string, values?: unknown[]) => Promise<unknown>;
    client.query = (async (...args: Parameters<PoolClient['query']>): Promise<unknown> => {
      const sql = args[0];
      if (typeof sql !== 'string') throw new Error('Expected a text query in credential fault injection');
      if (pending && sql.startsWith('SELECT * FROM integration_credentials')) {
        pending = false;
        internalPool.connect = connect;
        client.query = originalQuery;
        return query('SELECT pg_sleep(1)');
      }
      return query(sql, args[1]);
    }) as PoolClient['query'];
    return client;
  };
  return () => {
    internalPool.connect = connect;
  };
}
