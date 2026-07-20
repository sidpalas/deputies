import { randomUUID } from 'node:crypto';
import type { SnippetRecord, SnippetStore } from '../store/types.js';

const namePattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export class SnippetService {
  constructor(private readonly store: SnippetStore) {}

  list(userId: string) {
    return this.store.listSnippetsForUser(userId);
  }

  async create(userId: string, input: { name: unknown; body: unknown }): Promise<SnippetRecord> {
    const now = new Date();
    return this.store.createSnippet({
      id: randomUUID(),
      ownerUserId: userId,
      name: validName(input.name),
      body: validBody(input.body),
      createdAt: now,
      updatedAt: now,
    });
  }

  async update(userId: string, id: string, input: { name?: unknown; body?: unknown }): Promise<SnippetRecord> {
    if (input.name === undefined && input.body === undefined)
      throw new SnippetServiceError('invalid', 'Expected at least one of name or body');
    const existing = await this.require(userId, id);
    if (existing.archivedAt) throw new SnippetServiceError('archived', 'Restore this snippet before editing it');
    return (
      (await this.store.updateSnippet({
        id,
        ownerUserId: userId,
        ...(input.name === undefined ? {} : { name: validName(input.name) }),
        ...(input.body === undefined ? {} : { body: validBody(input.body) }),
        updatedAt: new Date(),
      })) ?? this.notFound()
    );
  }

  async archive(userId: string, id: string) {
    await this.require(userId, id);
    return (await this.store.archiveSnippet(id, userId, new Date())) ?? this.notFound();
  }
  async restore(userId: string, id: string) {
    await this.require(userId, id);
    return (await this.store.restoreSnippet(id, userId, new Date())) ?? this.notFound();
  }
  private async require(userId: string, id: string) {
    return (await this.store.getSnippetForUser(id, userId)) ?? this.notFound();
  }
  private notFound(): never {
    throw new SnippetServiceError('not_found', 'Snippet not found');
  }
}

export class SnippetServiceError extends Error {
  constructor(
    readonly code: 'invalid' | 'not_found' | 'archived',
    message: string,
  ) {
    super(message);
  }
}
function validName(value: unknown): string {
  if (typeof value !== 'string' || !namePattern.test(value) || value.length > 64)
    throw new SnippetServiceError('invalid', 'Name must be a lowercase slug of at most 64 characters');
  return value;
}
function validBody(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > 64 * 1024)
    throw new SnippetServiceError('invalid', 'Body must be non-empty and at most 64 KiB');
  return value;
}
