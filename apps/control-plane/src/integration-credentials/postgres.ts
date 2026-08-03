import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import type { CredentialIdentity, EncryptedCredentialPayload, IntegrationCredentialCipher } from './cipher.js';

export type CredentialKey = { scope: 'tenant'; namespace: string; name: string };
export type CredentialCodec<T> = {
  schema: string;
  version: number;
  encode(value: T): Uint8Array;
  decode(value: Uint8Array): T;
};
type Row = {
  id: string;
  scope: 'tenant';
  namespace: string;
  name: string;
  payload_schema: string;
  payload_version: number;
  encryption_version: 1;
  encryption_key_id: string;
  nonce: Buffer;
  ciphertext: Buffer;
  auth_tag: Buffer;
  revision: string;
  pending_operation_id: string | null;
  pending_operation_started_at: Date | null;
};
type RetainedOperation =
  | {
      mode: 'prepare';
      rowId: string;
      observed: Uint8Array;
      operationId: string;
    }
  | {
      mode: 'replace' | 'clear';
      rowId: string;
      observed: Uint8Array | undefined;
      replacementBytes: Uint8Array;
      operationId?: string;
    };

export class PostgresIntegrationCredentialRepository {
  private readonly pool: Pool;
  constructor(
    databaseUrl: string,
    private readonly cipher: IntegrationCredentialCipher,
    private readonly lockTimeoutMs = 15_000,
  ) {
    this.pool = new Pool({
      connectionString: databaseUrl,
      max: 4,
      connectionTimeoutMillis: lockTimeoutMs,
      statement_timeout: lockTimeoutMs,
      query_timeout: lockTimeoutMs,
    });
  }
  close(): Promise<void> {
    return this.pool.end();
  }

  async read<T>(key: CredentialKey, codec: CredentialCodec<T>): Promise<T | undefined> {
    const result = await this.pool.query<Row>(
      'SELECT * FROM integration_credentials WHERE scope=$1 AND namespace=$2 AND name=$3',
      [key.scope, key.namespace, key.name],
    );
    const row = result.rows[0];
    if (!row) return undefined;
    this.assertOperationSettled(row);
    return this.decode(row, codec);
  }

  async modify<T>(
    key: CredentialKey,
    codec: CredentialCodec<T>,
    operation: (current: T | undefined) => Promise<T | undefined>,
    options: { fenceProviderOperation?: boolean } = {},
  ): Promise<T | undefined> {
    let retained: RetainedOperation | undefined;
    try {
      return await this.withSemanticLock(key, async (client) => {
        const row = await this.readRow(client, key);
        if (row) this.assertOperationSettled(row);
        if (row && (row.payload_schema !== codec.schema || row.payload_version !== codec.version))
          throw new Error(`Unsupported integration credential payload ${row.payload_schema}/v${row.payload_version}`);
        const current = row ? this.decode(row, codec) : undefined;
        const observed = current === undefined ? undefined : codec.encode(current);
        const operationId = row && options.fenceProviderOperation !== false ? randomUUID() : undefined;
        if (row && operationId) {
          if (!observed) throw new Error('Stored integration credential encoded to an absent value');
          retained = { mode: 'prepare', rowId: row.id, observed, operationId };
          await this.establishOperationFence(client, row, operationId);
        }
        let replacement: T | undefined;
        try {
          replacement = await operation(current);
        } catch (error) {
          if (!operationId) throw error;
          // The callback may have reached a rotating provider even when it did
          // not return a replacement. Keep the durable fence so another replica
          // cannot replay the observed refresh token.
          throw new CredentialOperationOutcomeUncertainError();
        }
        let durable = current;
        if (replacement !== undefined) {
          const replacementBytes = codec.encode(replacement);
          const id = row?.id ?? randomUUID();
          retained = {
            rowId: id,
            observed,
            replacementBytes,
            ...(operationId ? { operationId } : {}),
            mode: 'replace',
          };
          const identity = this.identity(id, key, codec);
          const encrypted = this.cipher.encrypt(identity, replacementBytes);
          if (row) {
            await this.updateRow(client, row, encrypted, operationId);
          } else {
            try {
              await client.query(
                `INSERT INTO integration_credentials(id,scope,namespace,name,payload_schema,payload_version,encryption_version,encryption_key_id,nonce,ciphertext,auth_tag)
             VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
                [
                  id,
                  key.scope,
                  key.namespace,
                  key.name,
                  codec.schema,
                  codec.version,
                  encrypted.encryptionVersion,
                  encrypted.encryptionKeyId,
                  encrypted.nonce,
                  encrypted.ciphertext,
                  encrypted.authTag,
                ],
              );
            } catch {
              throw new UnconfirmedCredentialWriteError();
            }
          }
          durable = codec.decode(replacementBytes);
        } else if (row && operationId) {
          if (!observed) throw new Error('Stored integration credential encoded to an absent value');
          retained = {
            rowId: row.id,
            observed,
            replacementBytes: observed,
            operationId,
            mode: 'clear',
          };
          await this.clearOperationFence(client, row.id, operationId);
        }
        return durable;
      });
    } catch (error) {
      if (error instanceof UnconfirmedCredentialFenceWriteError && retained?.mode === 'prepare') {
        await this.recoverUnconfirmedFence(key, codec, retained, Date.now() + this.lockTimeoutMs);
        throw new Error('Integration credential operation did not start; retry the request', { cause: error });
      }
      if (!(error instanceof UnconfirmedCredentialWriteError) || !retained) throw error;
      if (retained.mode === 'prepare') throw error;
      return this.recoverUnconfirmedWrite(key, codec, retained, Date.now() + this.lockTimeoutMs);
    }
  }

  async delete(key: CredentialKey): Promise<void> {
    await this.withSemanticLock(key, async (client) => {
      const row = await this.readRow(client, key);
      if (row) this.assertOperationSettled(row);
      await client.query('DELETE FROM integration_credentials WHERE scope=$1 AND namespace=$2 AND name=$3', [
        key.scope,
        key.namespace,
        key.name,
      ]);
    });
  }
  private async withSemanticLock<T>(
    key: CredentialKey,
    operation: (client: PoolClient) => Promise<T>,
    deadline = Date.now() + this.lockTimeoutMs,
  ): Promise<T> {
    const client = await this.connectBefore(deadline);
    let locked = false;
    let destroy = false;
    const text = JSON.stringify(['deputies.integration-credential-lock', key.scope, key.namespace, key.name]);
    try {
      do {
        let result;
        try {
          result = await client.query<{ locked: boolean }>(
            'SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked',
            [text],
          );
        } catch {
          destroy = true;
          throw new Error('Failed to acquire integration credential lock');
        }
        locked = result.rows[0]?.locked === true;
        if (!locked) await new Promise((resolve) => setTimeout(resolve, 50));
      } while (!locked && Date.now() < deadline);
      if (!locked) throw new Error('Timed out waiting for integration credential lock');
      let value: T;
      try {
        value = await operation(client);
      } catch (operationError) {
        if (
          operationError instanceof UnconfirmedCredentialWriteError ||
          operationError instanceof UnconfirmedCredentialFenceWriteError ||
          operationError instanceof UnsafeCredentialConnectionError
        )
          destroy = true;
        try {
          const unlock = await client.query<{ unlocked: boolean }>(
            'SELECT pg_advisory_unlock(hashtextextended($1,0)) AS unlocked',
            [text],
          );
          if (unlock.rows[0]?.unlocked === true) locked = false;
          else destroy = true;
        } catch {
          destroy = true;
        }
        throw operationError;
      }
      let unlock;
      try {
        unlock = await client.query<{ unlocked: boolean }>(
          'SELECT pg_advisory_unlock(hashtextextended($1,0)) AS unlocked',
          [text],
        );
      } catch {
        destroy = true;
        throw new Error('Failed to release integration credential lock');
      }
      if (unlock.rows[0]?.unlocked !== true) {
        destroy = true;
        throw new Error('Failed to release integration credential lock');
      }
      locked = false;
      return value;
    } finally {
      client.release(destroy || locked);
    }
  }
  private async connectBefore(deadline: number): Promise<PoolClient> {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('Timed out waiting for integration credential lock');
    const pending = this.pool.connect();
    let timer: NodeJS.Timeout;
    try {
      return await Promise.race([
        pending,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('Timed out waiting for integration credential lock')), remaining);
        }),
      ]);
    } catch (error) {
      void pending.then((client) => client.release()).catch(() => undefined);
      throw error;
    } finally {
      clearTimeout(timer!);
    }
  }
  private async recoverUnconfirmedWrite<T>(
    key: CredentialKey,
    codec: CredentialCodec<T>,
    retained: Exclude<RetainedOperation, { mode: 'prepare' }>,
    deadline: number,
  ): Promise<T> {
    while (Date.now() < deadline) {
      try {
        return await this.withSemanticLock(
          key,
          async (client) => {
            const current = await this.readRow(client, key);
            // Absence cannot distinguish a pre-commit failure from an insert that
            // committed and was then explicitly deleted. Never resurrect it.
            if (!current && retained.observed === undefined) throw new UnsafeCredentialRecoveryError();
            if (
              !current ||
              current.id !== retained.rowId ||
              current.payload_schema !== codec.schema ||
              current.payload_version !== codec.version
            )
              throw new UnsafeCredentialRecoveryError();
            if (current.pending_operation_id && current.pending_operation_id !== retained.operationId)
              throw new UnsafeCredentialRecoveryError();
            const decoded = this.decode(current, codec);
            const bytes = codec.encode(decoded);
            const isReplacement = Buffer.from(bytes).equals(Buffer.from(retained.replacementBytes));
            const isObserved = retained.observed && Buffer.from(bytes).equals(Buffer.from(retained.observed));
            if (!current.pending_operation_id) {
              if (isReplacement) return decoded;
              // A different credential that was durably written outside this
              // operation is authoritative. Never publish our candidate.
              if (!isObserved) return decoded;
              throw new UnsafeCredentialRecoveryError();
            }
            if (retained.mode === 'clear') {
              if (!isObserved) throw new UnsafeCredentialRecoveryError();
              await this.clearOperationFence(client, current.id, retained.operationId!);
              return decoded;
            }
            // Replacement persistence changes the credential and clears the fence
            // atomically. A changed row that still carries this fence cannot be a
            // valid outcome of this operation, so preserve it and fail closed.
            if (!isObserved) throw new UnsafeCredentialRecoveryError();
            // The observed credential and our fence remain, so replacement did
            // not commit. Persist the callback result without replaying it.
            const encrypted = this.cipher.encrypt(this.identity(current.id, key, codec), retained.replacementBytes);
            await this.updateRow(client, current, encrypted, retained.operationId);
            return codec.decode(retained.replacementBytes);
          },
          deadline,
        );
      } catch (error) {
        if (error instanceof UnsafeCredentialRecoveryError) throw error;
        if (Date.now() >= deadline) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    throw new Error('Timed out recovering integration credential write');
  }
  private async recoverUnconfirmedFence<T>(
    key: CredentialKey,
    codec: CredentialCodec<T>,
    retained: Extract<RetainedOperation, { mode: 'prepare' }>,
    deadline: number,
  ): Promise<void> {
    while (Date.now() < deadline) {
      try {
        await this.withSemanticLock(
          key,
          async (client) => {
            const current = await this.readRow(client, key);
            if (
              !current ||
              current.id !== retained.rowId ||
              current.payload_schema !== codec.schema ||
              current.payload_version !== codec.version
            )
              throw new UnsafeCredentialRecoveryError();
            const bytes = codec.encode(this.decode(current, codec));
            if (!current.pending_operation_id) {
              if (!Buffer.from(bytes).equals(Buffer.from(retained.observed))) throw new UnsafeCredentialRecoveryError();
              return;
            }
            if (current.pending_operation_id !== retained.operationId) throw new UnsafeCredentialRecoveryError();
            if (!Buffer.from(bytes).equals(Buffer.from(retained.observed))) throw new UnsafeCredentialRecoveryError();
            await this.clearOperationFence(client, current.id, retained.operationId);
          },
          deadline,
        );
        return;
      } catch (error) {
        if (error instanceof UnsafeCredentialRecoveryError) throw error;
        if (Date.now() >= deadline) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    throw new Error('Timed out recovering integration credential operation fence');
  }
  private async establishOperationFence(client: PoolClient, row: Row, operationId: string): Promise<void> {
    let result;
    try {
      result = await client.query(
        `UPDATE integration_credentials
         SET pending_operation_id=$3,pending_operation_started_at=now()
         WHERE id=$1 AND revision=$2 AND pending_operation_id IS NULL`,
        [row.id, row.revision, operationId],
      );
    } catch {
      throw new UnconfirmedCredentialFenceWriteError();
    }
    if (result.rowCount !== 1) throw new UnconfirmedCredentialFenceWriteError();
  }
  private async clearOperationFence(client: PoolClient, rowId: string, operationId: string): Promise<void> {
    let result;
    try {
      result = await client.query(
        `UPDATE integration_credentials
         SET pending_operation_id=NULL,pending_operation_started_at=NULL
         WHERE id=$1 AND pending_operation_id=$2`,
        [rowId, operationId],
      );
    } catch {
      throw new UnconfirmedCredentialWriteError();
    }
    if (result.rowCount !== 1) throw new UnconfirmedCredentialWriteError();
  }
  private async updateRow(
    client: PoolClient,
    row: Row,
    encrypted: EncryptedCredentialPayload,
    operationId?: string,
  ): Promise<void> {
    let result;
    try {
      const values = [
        row.id,
        row.revision,
        encrypted.encryptionVersion,
        encrypted.encryptionKeyId,
        encrypted.nonce,
        encrypted.ciphertext,
        encrypted.authTag,
      ];
      result = operationId
        ? await client.query(
            `UPDATE integration_credentials SET encryption_version=$3,encryption_key_id=$4,nonce=$5,ciphertext=$6,auth_tag=$7,revision=revision+1,updated_at=now(),pending_operation_id=NULL,pending_operation_started_at=NULL
             WHERE id=$1 AND revision=$2 AND pending_operation_id=$8 RETURNING revision`,
            [...values, operationId],
          )
        : await client.query(
            `UPDATE integration_credentials SET encryption_version=$3,encryption_key_id=$4,nonce=$5,ciphertext=$6,auth_tag=$7,revision=revision+1,updated_at=now()
             WHERE id=$1 AND revision=$2 AND pending_operation_id IS NULL RETURNING revision`,
            values,
          );
    } catch {
      throw new UnconfirmedCredentialWriteError();
    }
    if (result.rowCount !== 1) throw new UnconfirmedCredentialWriteError();
  }
  private async readRow(client: PoolClient, key: CredentialKey): Promise<Row | undefined> {
    try {
      return (
        await client.query<Row>('SELECT * FROM integration_credentials WHERE scope=$1 AND namespace=$2 AND name=$3', [
          key.scope,
          key.namespace,
          key.name,
        ])
      ).rows[0];
    } catch {
      throw new UnsafeCredentialConnectionError();
    }
  }
  private identity<T>(id: string, key: CredentialKey, codec: CredentialCodec<T>): CredentialIdentity {
    return { id, ...key, payloadSchema: codec.schema, payloadVersion: codec.version };
  }
  private assertOperationSettled(row: Row): void {
    if (row.pending_operation_id)
      throw new CredentialOperationOutcomeUncertainError('Integration credential requires reconnection');
  }
  private decode<T>(row: Row, codec: CredentialCodec<T>): T {
    if (row.payload_schema !== codec.schema || row.payload_version !== codec.version)
      throw new Error(`Unsupported integration credential payload ${row.payload_schema}/v${row.payload_version}`);
    const encrypted: EncryptedCredentialPayload = {
      encryptionVersion: row.encryption_version,
      encryptionKeyId: row.encryption_key_id,
      nonce: row.nonce,
      ciphertext: row.ciphertext,
      authTag: row.auth_tag,
    };
    return codec.decode(this.cipher.decrypt(this.identity(row.id, row, codec), encrypted));
  }
}

class UnconfirmedCredentialWriteError extends Error {
  constructor() {
    super('Integration credential write outcome was not confirmed');
  }
}

class UnconfirmedCredentialFenceWriteError extends Error {
  constructor() {
    super('Integration credential operation fence outcome was not confirmed');
  }
}

class UnsafeCredentialRecoveryError extends Error {
  constructor() {
    super('Integration credential write could not be safely recovered');
  }
}

class UnsafeCredentialConnectionError extends Error {
  constructor() {
    super('Integration credential connection state is uncertain');
  }
}

class CredentialOperationOutcomeUncertainError extends Error {
  constructor(message = 'Integration credential operation outcome is uncertain; reconnect the provider') {
    super(message);
  }
}
