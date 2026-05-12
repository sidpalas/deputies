import { randomUUID } from 'node:crypto';
import type { MessageService } from '../messages/service.js';
import type { SessionService } from '../sessions/service.js';
import type { AppStore, MessageRecord, SessionRecord } from '../store/types.js';

export type IntegrationDeliveryRef = {
  source: string;
  dedupeKey: string;
};

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

export async function markIntegrationDeliveryFailed(
  store: AppStore,
  input: IntegrationDeliveryRef & { error: string },
): Promise<void> {
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
  if (store.withExternalThreadLock) {
    return store.withExternalThreadLock(input.source, input.externalId, () =>
      getOrCreateExternalThreadSessionUnlocked(store, sessions, input),
    );
  }

  return getOrCreateExternalThreadSessionUnlocked(store, sessions, input);
}

export async function enqueueIntegrationIngress(
  store: AppStore,
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

function compactRecord(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));
}

function assertIngressSourceMatchesThread(input: IntegrationIngress): void {
  if (input.thread.source !== input.source) {
    throw new Error(`Integration thread source must match message source: ${input.thread.source} !== ${input.source}`);
  }
}
