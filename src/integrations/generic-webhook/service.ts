import { randomUUID } from 'node:crypto';
import type { MessageService } from '../../messages/service.js';
import type { SessionService } from '../../sessions/service.js';
import type { AppStore, MessageRecord, SessionRecord, WebhookSourceRecord } from '../../store/types.js';

export type HandleGenericWebhookInput = {
  sourceKey: string;
  authorization: string | undefined;
  payload: Record<string, unknown>;
};

export type HandleGenericWebhookResult = {
  accepted: boolean;
  duplicate: boolean;
  session?: SessionRecord;
  message?: MessageRecord;
};

export class GenericWebhookService {
  constructor(
    private readonly store: AppStore,
    private readonly sessions: SessionService,
    private readonly messages: MessageService,
  ) {}

  async handle(input: HandleGenericWebhookInput): Promise<HandleGenericWebhookResult> {
    const source = await this.store.getWebhookSource(input.sourceKey);
    if (!source || !source.enabled) {
      throw new GenericWebhookError('not_found', 'Webhook source not found');
    }

    if (!isAuthorized(input.authorization, source)) {
      throw new GenericWebhookError('unauthorized', 'Invalid webhook authorization');
    }

    const parsed = parseWebhookPayload(input.payload);
    const delivery = await this.store.createIntegrationDelivery({
      id: randomUUID(),
      source: source.key,
      dedupeKey: parsed.dedupeKey,
      receivedAt: new Date(),
      metadata: { threadId: parsed.threadId },
    });

    if (!delivery) {
      return { accepted: true, duplicate: true };
    }

    const session = await this.getOrCreateSession(source, parsed);
    const message = await this.messages.enqueue({
      sessionId: session.id,
      prompt: renderPrompt(source, parsed.prompt),
      source: `generic:${source.key}`,
      context: {
        source: source.key,
        threadId: parsed.threadId,
        dedupeKey: parsed.dedupeKey,
        webhookContext: parsed.context,
        webhookPayload: input.payload,
        callback: parsed.callbackUrl ? { type: 'http', url: parsed.callbackUrl } : undefined,
      },
    });

    await this.store.markIntegrationDeliveryProcessed({
      source: source.key,
      dedupeKey: parsed.dedupeKey,
      processedAt: new Date(),
    });

    return { accepted: true, duplicate: false, session, message };
  }

  private async getOrCreateSession(
    source: WebhookSourceRecord,
    parsed: ParsedWebhookPayload,
  ): Promise<SessionRecord> {
    const existingThread = await this.store.getExternalThread(source.key, parsed.threadId);
    if (existingThread) {
      const session = await this.sessions.get(existingThread.sessionId);
      if (session) return session;
    }

    const session = await this.sessions.create(parsed.title ? { title: parsed.title } : { title: `Webhook: ${source.name}` });
    await this.store.createExternalThread({
      id: randomUUID(),
      source: source.key,
      externalId: parsed.threadId,
      sessionId: session.id,
      metadata: { sourceName: source.name },
      now: new Date(),
    });

    return session;
  }
}

type ParsedWebhookPayload = {
  threadId: string;
  dedupeKey: string;
  prompt: string;
  title?: string;
  callbackUrl?: string;
  context: Record<string, unknown>;
};

export class GenericWebhookError extends Error {
  constructor(
    readonly code: 'not_found' | 'unauthorized' | 'invalid_request',
    message: string,
  ) {
    super(message);
  }
}

function isAuthorized(authorization: string | undefined, source: WebhookSourceRecord): boolean {
  return authorization === `Bearer ${source.bearerToken}`;
}

function parseWebhookPayload(payload: Record<string, unknown>): ParsedWebhookPayload {
  const threadId = requiredString(payload.threadId, 'threadId');
  const dedupeKey = requiredString(payload.dedupeKey, 'dedupeKey');
  const prompt = requiredString(payload.prompt, 'prompt');
  const title = optionalString(payload.title);
  const callbackUrl = optionalUrl(payload.callbackUrl, 'callbackUrl');
  const context = isRecord(payload.context) ? payload.context : {};

  const parsed: ParsedWebhookPayload = { threadId, dedupeKey, prompt, context };
  if (title) parsed.title = title;
  if (callbackUrl) parsed.callbackUrl = callbackUrl;
  return parsed;
}

function renderPrompt(source: WebhookSourceRecord, prompt: string): string {
  if (!source.promptPrefix) return prompt;
  return `${source.promptPrefix}\n\n${prompt}`;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value === 'string' && value.trim()) return value;
  throw new GenericWebhookError('invalid_request', `Expected non-empty string field: ${field}`);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function optionalUrl(value: unknown, field: string): string | undefined {
  const raw = optionalString(value);
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    if (url.protocol === 'http:' || url.protocol === 'https:') return url.toString();
  } catch {
    // handled below
  }
  throw new GenericWebhookError('invalid_request', `Expected HTTP URL field: ${field}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
