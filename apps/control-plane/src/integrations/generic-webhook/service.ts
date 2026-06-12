import { timingSafeEqual } from 'node:crypto';

import type { MessageService } from '../../messages/service.js';
import type { SessionService } from '../../sessions/service.js';
import type { AppStore, MessageRecord, SessionRecord, WebhookSourceRecord } from '../../store/types.js';
import { parseHttpCallbackUrl } from '../../callbacks/service.js';
import { parseStructuredGitHubRepository } from '../../repositories/extract.js';
import {
  enqueueIntegrationIngress,
  markIntegrationDeliveryProcessed,
  receiveIntegrationDelivery,
  type IntegrationActor,
  type IntegrationIngress,
  type IntegrationRepository,
} from '../shared-utils.js';

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
    private readonly options: { unsafeAllowLocalHttpCallbacks?: boolean } = {},
  ) {}

  async handle(input: HandleGenericWebhookInput): Promise<HandleGenericWebhookResult> {
    const source = await this.store.getWebhookSource(input.sourceKey);
    if (!source || !source.enabled) {
      throw new GenericWebhookError('not_found', 'Webhook source not found');
    }

    if (!isAuthorized(input.authorization, source)) {
      throw new GenericWebhookError('unauthorized', 'Invalid webhook authorization');
    }

    const parsed = parseWebhookPayload(input.payload, this.options);
    const received = await receiveIntegrationDelivery(this.store, {
      source: source.key,
      dedupeKey: parsed.dedupeKey,
      metadata: { thread: parsed.thread },
    });

    if (!received) {
      return { accepted: true, duplicate: true };
    }

    const { session, message } = await enqueueIntegrationIngress(this.store, this.sessions, this.messages, {
      source: source.key,
      messageSource: `generic:${source.key}`,
      thread: { source: source.key, externalId: parsed.thread.externalId, metadata: parsed.thread.metadata },
      title: parsed.title ?? `Webhook: ${source.name}`,
      prompt: renderPrompt(source, parsed.prompt),
      dedupeKey: parsed.dedupeKey,
      ...(parsed.actor ? { actor: parsed.actor } : {}),
      ...(parsed.repository ? { repository: parsed.repository } : {}),
      ...(parsed.callback ? { callback: parsed.callback } : {}),
      sourceContext: { webhook: { sourceName: source.name, context: parsed.context } },
      context: parsed.context,
    });

    await markIntegrationDeliveryProcessed(this.store, {
      id: received.id,
      source: source.key,
      dedupeKey: parsed.dedupeKey,
    });

    return { accepted: true, duplicate: false, session, message };
  }
}

type ParsedWebhookPayload = {
  thread: IntegrationIngress['thread'];
  dedupeKey: string;
  prompt: string;
  title?: string;
  actor?: IntegrationActor;
  repository?: IntegrationRepository;
  callback?: Record<string, unknown>;
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
  if (authorization === undefined) return false;
  return safeEqual(authorization, `Bearer ${source.bearerToken}`);
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function parseWebhookPayload(
  payload: Record<string, unknown>,
  options: { unsafeAllowLocalHttpCallbacks?: boolean } = {},
): ParsedWebhookPayload {
  const thread = parseThread(payload.thread);
  const dedupeKey = requiredString(payload.dedupeKey, 'dedupeKey');
  const prompt = requiredString(payload.prompt, 'prompt');
  const title = optionalString(payload.title);
  const actor = parseActor(payload.actor);
  const repository = parseRepository(payload.repository);
  const callback = parseCallback(payload.callback, options);
  const context = isRecord(payload.context) ? payload.context : {};

  const parsed: ParsedWebhookPayload = { thread, dedupeKey, prompt, context };
  if (title) parsed.title = title;
  if (actor) parsed.actor = actor;
  if (repository) parsed.repository = repository;
  if (callback) parsed.callback = callback;
  return parsed;
}

function parseThread(value: unknown): IntegrationIngress['thread'] {
  if (!isRecord(value)) throw new GenericWebhookError('invalid_request', 'Expected object field: thread');
  return {
    source: 'generic',
    externalId: requiredString(value.externalId, 'thread.externalId'),
    metadata: isRecord(value.metadata) ? value.metadata : {},
  };
}

function parseActor(value: unknown): IntegrationActor | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new GenericWebhookError('invalid_request', 'Expected object field: actor');
  const type = value.type;
  if (type !== 'user' && type !== 'bot' && type !== 'system') {
    throw new GenericWebhookError('invalid_request', 'Expected actor.type to be user, bot, or system');
  }
  const displayName = optionalString(value.displayName);
  return {
    type,
    externalId: requiredString(value.externalId, 'actor.externalId'),
    ...(displayName ? { displayName } : {}),
  };
}

function parseRepository(value: unknown): IntegrationRepository | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new GenericWebhookError('invalid_request', 'Expected object field: repository');
  if (value.provider !== 'github')
    throw new GenericWebhookError('invalid_request', 'Expected repository.provider to be github');
  const owner = requiredString(value.owner, 'repository.owner');
  const repo = requiredString(value.repo, 'repository.repo');
  const repository = parseStructuredGitHubRepository(owner, repo);
  if (!repository) throw new GenericWebhookError('invalid_request', 'Expected valid GitHub repository owner/repo');
  return repository;
}

function parseCallback(
  value: unknown,
  options: { unsafeAllowLocalHttpCallbacks?: boolean } = {},
): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new GenericWebhookError('invalid_request', 'Expected object field: callback');
  if (value.type === 'http') {
    return { type: 'http', url: httpUrl(value.url, 'callback.url', options) };
  }
  throw new GenericWebhookError('invalid_request', 'Expected callback.type to be http');
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

function httpUrl(value: unknown, field: string, options: { unsafeAllowLocalHttpCallbacks?: boolean } = {}): string {
  const raw = requiredString(value, field);
  try {
    return parseHttpCallbackUrl(raw, {
      unsafeAllowLocalNetwork: Boolean(options.unsafeAllowLocalHttpCallbacks),
    }).toString();
  } catch {
    // handled below
  }
  throw new GenericWebhookError('invalid_request', `Expected HTTP URL field: ${field}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
