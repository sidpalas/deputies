import type { Credential, CredentialInfo, CredentialStore } from '@earendil-works/pi-ai';
import { PostgresIntegrationCredentialRepository, type CredentialKey } from '../integration-credentials/postgres.js';
import {
  openAICodexCredentialCodec,
  parseOpenAICodexSeed,
  type PiOAuthCredentialV1,
} from '../runner/openai-codex-credentials.js';

const providerId = 'openai-codex';
const key: CredentialKey = { scope: 'tenant', namespace: 'model-provider', name: providerId };

export type CodexCredentialRepository = Pick<PostgresIntegrationCredentialRepository, 'read' | 'modify' | 'delete'>;

export class PostgresCodexCredentialStore implements CredentialStore {
  constructor(private readonly repository: CodexCredentialRepository) {}

  async read(candidateProviderId: string): Promise<Credential | undefined> {
    if (candidateProviderId !== providerId) return undefined;
    return this.repository.read(key, openAICodexCredentialCodec);
  }

  async list(): Promise<readonly CredentialInfo[]> {
    return (await this.read(providerId)) ? [{ providerId, type: 'oauth' }] : [];
  }

  modify(
    candidateProviderId: string,
    operation: (current: Credential | undefined) => Promise<Credential | undefined>,
  ): Promise<Credential | undefined> {
    assertProvider(candidateProviderId);
    return this.repository.modify(key, openAICodexCredentialCodec, async (current) => {
      const candidate = await operation(current);
      return candidate === undefined ? undefined : validateCandidate(candidate);
    });
  }

  async delete(candidateProviderId: string): Promise<void> {
    assertProvider(candidateProviderId);
    throw new Error('PostgreSQL Codex credential deletion requires an explicit reconnect workflow');
  }
}

export async function createPostgresCodexCredentialStore(
  repository: CodexCredentialRepository,
  seedBase64?: string,
): Promise<CredentialStore> {
  await repository.modify(
    key,
    openAICodexCredentialCodec,
    async (current) => {
      if (current) return undefined;
      return seedBase64 ? parseOpenAICodexSeed(seedBase64) : undefined;
    },
    { fenceProviderOperation: false },
  );
  return new PostgresCodexCredentialStore(repository);
}

function assertProvider(candidateProviderId: string): void {
  if (candidateProviderId !== providerId)
    throw new Error(`PostgreSQL credential storage does not support provider: ${candidateProviderId}`);
}

function validateCandidate(candidate: Credential): PiOAuthCredentialV1 {
  return openAICodexCredentialCodec.decode(openAICodexCredentialCodec.encode(candidate as PiOAuthCredentialV1));
}
