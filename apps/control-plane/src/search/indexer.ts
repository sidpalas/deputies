import {
  runWithOptionalAdvisoryLock,
  startPeriodicTask,
  type AdvisoryLockStore,
  type PeriodicTaskHandle,
} from '../app/periodic-task.js';
import type { EventService } from '../events/service.js';
import type { AppStore, EventRecord, MessageRecord, SessionSearchDocInput } from '../store/types.js';

const searchIndexerLockId = 742_358_004;
const defaultBatchSize = 5_000;
const defaultMaxBatchesPerRun = 20;
const maxIndexedContentChars = 16 * 1024;

export type SessionSearchIndexerOptions = {
  store: AppStore & Partial<AdvisoryLockStore>;
  events: EventService;
  batchSize?: number;
  maxBatchesPerRun?: number;
  intervalMs?: number;
  onError?: (error: unknown) => void;
};

export type SessionSearchIndexerHandle = PeriodicTaskHandle;

export async function runSessionSearchIndexerOnce(
  options: Pick<SessionSearchIndexerOptions, 'store' | 'events' | 'batchSize' | 'maxBatchesPerRun'>,
): Promise<number> {
  const run = async () => {
    let afterId = await options.store.getSearchIndexCursor();
    let indexed = 0;
    const maxBatches = options.maxBatchesPerRun ?? defaultMaxBatchesPerRun;
    for (let batchIndex = 0; batchIndex < maxBatches; batchIndex += 1) {
      const batch = await options.events.listAllBatch(afterId, options.batchSize ?? defaultBatchSize, true);
      const docs = await searchDocsForEvents(options.store, batch.events);
      await options.store.upsertSessionSearchDocs(docs);
      await options.store.setSearchIndexCursor(batch.cursor);
      indexed += docs.length;
      if (!batch.hasMore || batch.cursor === afterId) break;
      afterId = batch.cursor;
    }
    return indexed;
  };

  return runWithOptionalAdvisoryLock({ store: options.store, lockId: searchIndexerLockId, run, locked: 0 });
}

export function startSessionSearchIndexer(options: SessionSearchIndexerOptions): SessionSearchIndexerHandle {
  return startPeriodicTask({
    run: () => runSessionSearchIndexerOnce(options),
    intervalMs: options.intervalMs,
    onError: options.onError,
  });
}

async function searchDocsForEvents(store: AppStore, events: EventRecord[]): Promise<SessionSearchDocInput[]> {
  const docs: SessionSearchDocInput[] = [];
  const messagesBySession = new Map<string, Promise<MessageRecord[]>>();
  for (const event of events) {
    if (event.type === 'session_created' || event.type === 'session_updated') {
      const title = trimIndexedContent(typeof event.payload.title === 'string' ? event.payload.title : '');
      if (!title) continue;
      docs.push({
        sessionId: event.sessionId,
        kind: 'title',
        sourceId: event.sessionId,
        content: title,
        createdAt: event.createdAt,
      });
      continue;
    }

    if ((event.type === 'message_created' || event.type === 'message_updated') && event.messageId) {
      const messagesPromise = messagesBySession.get(event.sessionId) ?? store.getMessages(event.sessionId);
      messagesBySession.set(event.sessionId, messagesPromise);
      const message = (await messagesPromise).find((candidate) => candidate.id === event.messageId);
      if (!message) continue;
      docs.push({
        sessionId: event.sessionId,
        kind: 'prompt',
        sourceId: message.id,
        content: trimIndexedContent(message.prompt),
        createdAt: message.createdAt,
      });
      continue;
    }

    if (event.type === 'agent_response_final' && typeof event.payload.text === 'string') {
      docs.push({
        sessionId: event.sessionId,
        kind: 'response',
        sourceId: String(event.id),
        content: trimIndexedContent(event.payload.text),
        createdAt: event.createdAt,
      });
    }
  }
  return uniqueSearchDocs(docs);
}

function trimIndexedContent(value: string): string {
  return value.replaceAll('\u0000', '').slice(0, maxIndexedContentChars);
}

function uniqueSearchDocs(docs: SessionSearchDocInput[]): SessionSearchDocInput[] {
  const byKey = new Map<string, SessionSearchDocInput>();
  for (const doc of docs) byKey.set(`${doc.sessionId}:${doc.kind}:${doc.sourceId}`, doc);
  return [...byKey.values()];
}
