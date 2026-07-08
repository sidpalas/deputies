import { randomUUID } from 'node:crypto';
import type { MessageService } from '../messages/service.js';
import type { SessionService } from '../sessions/service.js';
import type { IntegrationDeliveryRecord, IntegrationStore, MessageRecord, SessionRecord } from '../store/types.js';
import { defaultGroupId } from '../store/types.js';

export type IntegrationDeliveryRef = {
  source: string;
  dedupeKey: string;
};

export type IntegrationDeliveryLease = IntegrationDeliveryRef & {
  id: string;
};

const staleIntegrationDeliveryMs = 15 * 60_000;

export type IntegrationActor = {
  type: 'user' | 'bot' | 'system';
  externalId: string;
  displayName?: string;
};

export type IntegrationRepository = {
  provider: 'github';
  owner: string;
  repo: string;
};

export type IntegrationThreadRef = {
  source: string;
  externalId: string;
  metadata: Record<string, unknown>;
};

export type IntegrationIngress = {
  source: string;
  messageSource?: string;
  sessionTags?: string[];
  thread: IntegrationThreadRef;
  title: string;
  prompt: string;
  dedupeKey?: string;
  actor?: IntegrationActor;
  repository?: IntegrationRepository;
  callback?: Record<string, unknown>;
  sourceContext?: Record<string, unknown>;
  context?: Record<string, unknown>;
};

export type IntegrationIngressResult = {
  session: SessionRecord;
  message: MessageRecord;
};

type ExternalThreadSessionInput = {
  source: string;
  externalId: string;
  metadata: Record<string, unknown>;
  title: string;
  tags?: string[];
};

export async function receiveIntegrationDelivery(
  store: IntegrationStore,
  input: IntegrationDeliveryRef & { metadata: Record<string, unknown> },
): Promise<IntegrationDeliveryRecord | null> {
  const receivedAt = new Date();
  return store.createIntegrationDelivery({
    id: randomUUID(),
    source: input.source,
    dedupeKey: input.dedupeKey,
    receivedAt,
    staleReceivedBefore: new Date(receivedAt.getTime() - staleIntegrationDeliveryMs),
    metadata: input.metadata,
  });
}

export async function markIntegrationDeliveryProcessed(
  store: IntegrationStore,
  input: IntegrationDeliveryLease,
): Promise<void> {
  const finalized = await store.markIntegrationDeliveryProcessed({ ...input, processedAt: new Date() });
  if (!finalized)
    throw new Error(`Integration delivery lease lost before processing completed: ${input.source}/${input.dedupeKey}`);
}

export async function markIntegrationDeliveryFailed(
  store: IntegrationStore,
  input: IntegrationDeliveryLease & { error: string },
): Promise<void> {
  const finalized = await store.markIntegrationDeliveryFailed({ ...input, failedAt: new Date() });
  if (!finalized)
    throw new Error(`Integration delivery lease lost before failure completed: ${input.source}/${input.dedupeKey}`);
}

export async function getOrCreateExternalThreadSession(
  store: IntegrationStore,
  sessions: SessionService,
  input: ExternalThreadSessionInput,
): Promise<SessionRecord> {
  if (store.withExternalThreadLock) {
    return store.withExternalThreadLock(input.source, input.externalId, () =>
      getOrCreateExternalThreadSessionUnlocked(store, sessions, input),
    );
  }

  return getOrCreateExternalThreadSessionUnlocked(store, sessions, input);
}

export async function enqueueIntegrationIngress(
  store: IntegrationStore,
  sessions: SessionService,
  messages: MessageService,
  input: IntegrationIngress,
): Promise<IntegrationIngressResult> {
  assertIngressSourceMatchesThread(input);
  const session = await getOrCreateExternalThreadSession(store, sessions, {
    source: input.thread.source,
    externalId: input.thread.externalId,
    metadata: input.thread.metadata,
    title: input.title,
    ...(input.sessionTags ? { tags: input.sessionTags } : {}),
  });
  const message = await enqueueIntegrationMessage(messages, session, input);
  return { session, message };
}

export async function enqueueIntegrationMessage(
  messages: MessageService,
  session: SessionRecord,
  input: IntegrationIngress,
): Promise<MessageRecord> {
  assertIngressSourceMatchesThread(input);
  return messages.enqueue({
    sessionId: session.id,
    prompt: input.prompt,
    ...(input.actor ? { authorName: input.actor.displayName ?? input.actor.externalId } : {}),
    source: input.messageSource ?? input.source,
    context: integrationMessageContext(input),
  });
}

export function integrationMessageContext(input: IntegrationIngress): Record<string, unknown> {
  return compactRecord({
    ...input.context,
    source: input.source,
    integration: compactRecord({
      source: input.source,
      thread: { source: input.thread.source, externalId: input.thread.externalId },
      dedupeKey: input.dedupeKey,
      actor: input.actor,
    }),
    repository: input.repository,
    callback: input.callback,
    ...input.sourceContext,
  });
}

async function getOrCreateExternalThreadSessionUnlocked(
  store: IntegrationStore,
  sessions: SessionService,
  input: ExternalThreadSessionInput,
): Promise<SessionRecord> {
  const existingThread = await store.getExternalThread(input.source, input.externalId);
  if (existingThread) {
    const session = await sessions.get(existingThread.sessionId);
    if (session) return session;
  }

  const createdSession = await sessions.create({
    title: input.title,
    ownerGroupId: defaultGroupId,
    visibility: 'group',
    writePolicy: 'creator_only',
    ...(input.tags ? { tags: input.tags } : {}),
  });
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

function compactRecord(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));
}

function assertIngressSourceMatchesThread(input: IntegrationIngress): void {
  if (input.thread.source !== input.source) {
    throw new Error(`Integration thread source must match message source: ${input.thread.source} !== ${input.source}`);
  }
}
