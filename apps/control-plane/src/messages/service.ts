import { randomUUID } from 'node:crypto';
import type { EventService } from '../events/service.js';
import type { MessageRecord, MessageStore } from '../store/types.js';

export type EnqueueMessageInput = {
  id?: string;
  sessionId: string;
  prompt: string;
  authorUserId?: string;
  authorName?: string;
  source?: string;
  context?: Record<string, unknown>;
};

export type RecordTranscriptEntryInput = EnqueueMessageInput & {
  status?: 'cancelled' | 'completed';
};

export class MessageService {
  constructor(
    private readonly store: MessageStore,
    private readonly events: EventService,
  ) {}

  async enqueue(input: EnqueueMessageInput): Promise<MessageRecord> {
    const session = await this.store.getSession(input.sessionId);
    if (!session) {
      throw new MessageServiceError('not_found', `Session not found: ${input.sessionId}`);
    }
    if (session.status === 'archived') {
      throw new MessageServiceError('conflict', 'Cannot enqueue messages to an archived session');
    }

    const context = mergeMessageContext(session.context, input.context);
    const sessionContext = mergeSessionContext(session.context, input.context);
    if (sessionContext) {
      const updatedSession = await this.store.updateSessionContext({
        id: session.id,
        context: sessionContext,
        updatedAt: new Date(),
      });
      await this.events.append({
        sessionId: input.sessionId,
        type: 'session_updated',
        payload: { title: updatedSession.title ?? null, context: updatedSession.context ?? null },
      });
    }

    const sequence = await this.store.nextMessageSequence(input.sessionId);
    const record: MessageRecord = {
      id: input.id ?? randomUUID(),
      sessionId: input.sessionId,
      sequence,
      status: 'pending',
      prompt: input.prompt,
      createdAt: new Date(),
    };

    if (input.authorUserId) record.authorUserId = input.authorUserId;
    if (input.authorName) record.authorName = input.authorName;
    if (input.source) record.source = input.source;
    if (context) record.context = context;

    const message = await this.store.createMessage(record);
    await this.events.append({
      sessionId: input.sessionId,
      messageId: message.id,
      type: 'message_created',
      payload: { sequence: message.sequence, source: message.source ?? null },
    });

    return message;
  }

  async list(sessionId: string): Promise<MessageRecord[]> {
    return this.store.getMessages(sessionId);
  }

  async recordTranscriptEntry(input: RecordTranscriptEntryInput): Promise<MessageRecord> {
    const session = await this.store.getSession(input.sessionId);
    if (!session) throw new MessageServiceError('not_found', `Session not found: ${input.sessionId}`);

    const sequence = await this.store.nextMessageSequence(input.sessionId);
    const record: MessageRecord = {
      id: randomUUID(),
      sessionId: input.sessionId,
      sequence,
      status: input.status ?? 'cancelled',
      prompt: input.prompt,
      createdAt: new Date(),
    };
    if (input.authorUserId) record.authorUserId = input.authorUserId;
    if (input.authorName) record.authorName = input.authorName;
    if (input.source) record.source = input.source;
    if (input.context) record.context = input.context;

    const message = await this.store.createMessage(record);
    await this.events.append({
      sessionId: input.sessionId,
      messageId: message.id,
      type: 'message_created',
      payload: { sequence: message.sequence, source: message.source ?? null, transcriptOnly: true },
    });
    if (message.status === 'cancelled') {
      await this.events.append({
        sessionId: input.sessionId,
        messageId: message.id,
        type: 'message_cancelled',
        payload: { sequence: message.sequence, transcriptOnly: true },
      });
    }

    return message;
  }

  async updatePending(input: {
    sessionId: string;
    messageId: string;
    prompt: string;
    context?: Record<string, unknown>;
  }): Promise<MessageRecord> {
    const message = await this.store.updatePendingMessage(input);
    if (!message) throw new MessageServiceError('conflict', 'Message is not pending or does not exist');
    await this.events.append({
      sessionId: input.sessionId,
      messageId: message.id,
      type: 'message_updated',
      payload: { sequence: message.sequence },
    });
    return message;
  }

  async cancelPending(input: { sessionId: string; messageId: string }): Promise<MessageRecord> {
    const message = await this.store.cancelPendingMessage({ ...input, cancelledAt: new Date() });
    if (!message) throw new MessageServiceError('conflict', 'Message is not pending or does not exist');
    await this.events.append({
      sessionId: input.sessionId,
      messageId: message.id,
      type: 'message_cancelled',
      payload: { sequence: message.sequence },
    });
    return message;
  }

  async retryFailed(input: { sessionId: string; messageId: string }): Promise<MessageRecord> {
    const session = await this.store.getSession(input.sessionId);
    if (!session) throw new MessageServiceError('not_found', `Session not found: ${input.sessionId}`);
    if (session.status === 'archived')
      throw new MessageServiceError('conflict', 'Cannot retry messages in an archived session');

    const messages = await this.store.getMessages(input.sessionId);
    const failedMessage = messages.find((message) => message.id === input.messageId);
    if (!failedMessage) throw new MessageServiceError('not_found', `Message not found: ${input.messageId}`);
    if (failedMessage.status !== 'failed')
      throw new MessageServiceError('conflict', 'Only failed messages can be retried');

    return this.enqueue({
      sessionId: input.sessionId,
      prompt: failedMessage.prompt,
      ...(failedMessage.authorUserId ? { authorUserId: failedMessage.authorUserId } : {}),
      ...(failedMessage.authorName ? { authorName: failedMessage.authorName } : {}),
      ...(failedMessage.source ? { source: failedMessage.source } : {}),
      ...(failedMessage.context ? { context: failedMessage.context } : {}),
    });
  }

  async cancelActiveRun(input: { sessionId: string }): Promise<MessageRecord[]> {
    const session = await this.store.getSession(input.sessionId);
    if (!session) throw new MessageServiceError('not_found', `Session not found: ${input.sessionId}`);

    const cancelling = await this.store.requestRunCancellation({
      sessionId: input.sessionId,
      requestedAt: new Date(),
      error: 'Run cancellation requested by user',
    });
    if (!cancelling) throw new MessageServiceError('conflict', 'Session has no active run to cancel');

    const primary = cancelling.messages[0];
    await this.events.append({
      sessionId: input.sessionId,
      runId: cancelling.run.id,
      ...(primary ? { messageId: primary.id } : {}),
      type: 'run_cancel_requested',
      payload: {
        sequences: cancelling.messages.map((message) => message.sequence),
        batchSize: cancelling.messages.length,
      },
    });

    return cancelling.messages;
  }
}

function mergeMessageContext(
  sessionContext: Record<string, unknown> | undefined,
  messageContext: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  const context =
    sessionContext && messageContext ? { ...sessionContext, ...messageContext } : (messageContext ?? sessionContext);
  if (!context || !messageContext) return context;
  return clearOppositeCodebaseContext(context, messageContext);
}

function mergeSessionContext(
  sessionContext: Record<string, unknown> | undefined,
  messageContext: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!messageContext) return undefined;
  const nextContext = { ...(sessionContext ?? {}) };
  let changed = false;
  for (const key of ['repository', 'model', 'reasoningLevel', 'branch', 'environment']) {
    if (!Object.prototype.hasOwnProperty.call(messageContext, key)) continue;
    nextContext[key] = messageContext[key];
    changed = true;
  }
  clearOppositeCodebaseContext(nextContext, messageContext);
  return changed ? nextContext : undefined;
}

function clearOppositeCodebaseContext(
  context: Record<string, unknown>,
  messageContext: Record<string, unknown>,
): Record<string, unknown> {
  if (Object.prototype.hasOwnProperty.call(messageContext, 'environment')) {
    delete context.repository;
    delete context.branch;
    delete context.activeRepository;
  } else if (Object.prototype.hasOwnProperty.call(messageContext, 'repository')) {
    delete context.environment;
    delete context.activeRepository;
  }
  return context;
}

export class MessageServiceError extends Error {
  constructor(
    readonly code: 'not_found' | 'conflict',
    message: string,
  ) {
    super(message);
  }
}
