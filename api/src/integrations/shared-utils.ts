import { randomUUID } from 'node:crypto';
import type { SessionService } from '../sessions/service.js';
import type { AppStore, SessionRecord } from '../store/types.js';

export type IntegrationDeliveryRef = {
  source: string;
  dedupeKey: string;
};

export async function receiveIntegrationDelivery(
  store: AppStore,
  input: IntegrationDeliveryRef & { metadata: Record<string, unknown> },
): Promise<boolean> {
  const delivery = await store.createIntegrationDelivery({
    id: randomUUID(),
    source: input.source,
    dedupeKey: input.dedupeKey,
    receivedAt: new Date(),
    metadata: input.metadata,
  });
  return Boolean(delivery);
}

export async function markIntegrationDeliveryProcessed(store: AppStore, input: IntegrationDeliveryRef): Promise<void> {
  await store.markIntegrationDeliveryProcessed({ ...input, processedAt: new Date() });
}

export async function markIntegrationDeliveryFailed(store: AppStore, input: IntegrationDeliveryRef & { error: string }): Promise<void> {
  await store.markIntegrationDeliveryFailed({ ...input, failedAt: new Date() });
}

export async function getOrCreateExternalThreadSession(
  store: AppStore,
  sessions: SessionService,
  input: {
    source: string;
    externalId: string;
    metadata: Record<string, unknown>;
    title: string;
  },
): Promise<SessionRecord> {
  const existingThread = await store.getExternalThread(input.source, input.externalId);
  if (existingThread) {
    const session = await sessions.get(existingThread.sessionId);
    if (session) return session;
  }

  const createdSession = await sessions.create({ title: input.title });
  const thread = await store.createExternalThread({
    id: randomUUID(),
    source: input.source,
    externalId: input.externalId,
    sessionId: createdSession.id,
    metadata: input.metadata,
    now: new Date(),
  });
  if (thread.sessionId === createdSession.id) return createdSession;

  const winningSession = await sessions.get(thread.sessionId);
  return winningSession ?? createdSession;
}
