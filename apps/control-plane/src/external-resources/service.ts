import { randomUUID } from 'node:crypto';
import type { EventService } from '../events/service.js';
import type { CreateExternalResourceRecord, ExternalResourceRecord } from '../store/types.js';

type ExternalResourceStore = {
  createExternalResource(record: CreateExternalResourceRecord): Promise<ExternalResourceRecord>;
  getExternalResources(sessionId: string): Promise<ExternalResourceRecord[]>;
};

type CreateExternalResourceInput = {
  sessionId: string;
  type: string;
  url: string;
  metadata?: Record<string, unknown>;
  runId?: string;
  messageId?: string;
  title?: string;
};

export class ExternalResourceService {
  constructor(
    private readonly store: ExternalResourceStore,
    private readonly events: EventService,
  ) {}

  async create(input: CreateExternalResourceInput): Promise<ExternalResourceRecord> {
    const record = await this.store.createExternalResource({
      id: randomUUID(),
      sessionId: input.sessionId,
      type: input.type,
      url: input.url,
      metadata: input.metadata ?? {},
      createdAt: new Date(),
      ...(input.runId ? { runId: input.runId } : {}),
      ...(input.messageId ? { messageId: input.messageId } : {}),
      ...(input.title ? { title: input.title } : {}),
    });
    await this.events.append({
      sessionId: input.sessionId,
      ...(input.runId ? { runId: input.runId } : {}),
      ...(input.messageId ? { messageId: input.messageId } : {}),
      type: 'external_resource_created',
      payload: { resource: record },
    });
    return record;
  }

  async list(sessionId: string): Promise<ExternalResourceRecord[]> {
    return this.store.getExternalResources(sessionId);
  }
}
