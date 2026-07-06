import {
  publicApiResponseSchemas,
  type PublicApiResponseField,
  type PublicApiResponseSchemaName,
} from '../../src/app/response-schemas.js';

const eventTypes = new Set([
  'session_created',
  'session_archived',
  'session_unarchived',
  'session_updated',
  'session_queue_paused',
  'session_queue_resumed',
  'message_created',
  'message_updated',
  'message_cancelled',
  'message_started',
  'run_started',
  'sandbox_starting',
  'sandbox_ready',
  'sandbox_destroyed',
  'sandbox_destroy_failed',
  'sandbox_stopped',
  'sandbox_stop_failed',
  'repository_ready',
  'setup_script_started',
  'setup_script_finished',
  'agent_text_delta',
  'agent_response_final',
  'tool_started',
  'tool_finished',
  'artifact_created',
  'run_completed',
  'run_failed',
  'run_cancel_requested',
  'run_cancelled',
  'message_completed',
  'message_failed',
  'callback_sent',
  'callback_retry_scheduled',
  'callback_failed',
  'callback_replay_requested',
]);

export function expectSessionResponse(
  value: unknown,
): asserts value is { session: { id: string; status: string; title?: string } } {
  expectResponseSchemaField('session', 'session');
  expect(isRecord(value)).toBe(true);
  const session = isRecord(value) ? value.session : undefined;
  expect(isRecord(session)).toBe(true);
  if (!isRecord(session)) return;
  expect(typeof session.id).toBe('string');
  expect(typeof session.status).toBe('string');
  expect(typeof session.createdAt).toBe('string');
  expect(typeof session.updatedAt).toBe('string');
  if (session.title !== undefined) expect(typeof session.title).toBe('string');
}

export function expectSessionsResponse(
  value: unknown,
): asserts value is { sessions: Array<{ id: string; status: string; title?: string }> } {
  expectResponseSchemaField('sessions', 'sessions');
  expect(isRecord(value)).toBe(true);
  const sessions = isRecord(value) ? value.sessions : undefined;
  expect(Array.isArray(sessions)).toBe(true);
  if (!Array.isArray(sessions)) return;
  for (const session of sessions) expectSessionRecord(session);
}

export function expectMessageResponse(
  value: unknown,
): asserts value is { message: { id: string; sessionId: string; sequence: number; status: string; prompt: string } } {
  expectResponseSchemaField('message', 'message');
  expect(isRecord(value)).toBe(true);
  const message = isRecord(value) ? value.message : undefined;
  expect(isRecord(message)).toBe(true);
  if (!isRecord(message)) return;
  expect(typeof message.id).toBe('string');
  expect(typeof message.sessionId).toBe('string');
  expect(typeof message.sequence).toBe('number');
  expect(typeof message.status).toBe('string');
  expect(typeof message.prompt).toBe('string');
  expect(typeof message.createdAt).toBe('string');
}

export function expectMessagesResponse(value: unknown): asserts value is {
  messages: Array<{ id: string; sessionId: string; sequence: number; status: string; prompt: string }>;
} {
  expectResponseSchemaField('messages', 'messages');
  expect(isRecord(value)).toBe(true);
  const messages = isRecord(value) ? value.messages : undefined;
  expect(Array.isArray(messages)).toBe(true);
  if (!Array.isArray(messages)) return;
  for (const message of messages) expectMessageRecord(message);
}

export function expectEventsResponse(
  value: unknown,
): asserts value is { events: Array<{ type: string; sequence: number }> } {
  expectResponseSchemaField('events', 'events');
  expectEventListEnvelope(value);
}

export function expectGlobalEventsResponse(
  value: unknown,
): asserts value is { events: Array<{ type: string; sequence: number }>; cursor: number; hasMore: boolean } {
  expectResponseSchemaField('globalEvents', 'events');
  expectResponseSchemaField('globalEvents', 'cursor', 'number');
  expectResponseSchemaField('globalEvents', 'hasMore', 'boolean');
  expectEventListEnvelope(value);
  if (!isRecord(value)) return;
  expect(typeof value.cursor).toBe('number');
  expect(typeof value.hasMore).toBe('boolean');
}

function expectEventListEnvelope(value: unknown): void {
  expect(isRecord(value)).toBe(true);
  const events = isRecord(value) ? value.events : undefined;
  expect(Array.isArray(events)).toBe(true);
  if (!Array.isArray(events)) return;
  for (const event of events) expectNormalizedEvent(event);
}

export function expectArtifactsResponse(
  value: unknown,
): asserts value is { artifacts: Array<{ id: string; type: string; payload: Record<string, unknown> }> } {
  expectResponseSchemaField('artifacts', 'artifacts');
  expect(isRecord(value)).toBe(true);
  const artifacts = isRecord(value) ? value.artifacts : undefined;
  expect(Array.isArray(artifacts)).toBe(true);
  if (!Array.isArray(artifacts)) return;
  for (const artifact of artifacts) {
    expect(isRecord(artifact)).toBe(true);
    if (!isRecord(artifact)) continue;
    expect(typeof artifact.id).toBe('string');
    expect(typeof artifact.sessionId).toBe('string');
    expect(typeof artifact.type).toBe('string');
    expect(typeof artifact.createdAt).toBe('string');
    expect(isRecord(artifact.payload)).toBe(true);
    if (artifact.url !== undefined) expect(typeof artifact.url).toBe('string');
  }
}

export function expectArtifactPreviewResponse(value: unknown): asserts value is {
  artifact: { id: string; type: string; payload: Record<string, unknown> };
  preview: { text: string; contentType: string; truncated: boolean; sizeBytes: number };
} {
  expectResponseSchemaField('artifactPreview', 'artifact');
  expectResponseSchemaField('artifactPreview', 'preview');
  expect(isRecord(value)).toBe(true);
  if (!isRecord(value)) return;
  expect(isRecord(value.artifact)).toBe(true);
  expect(isRecord(value.preview)).toBe(true);
  if (!isRecord(value.artifact) || !isRecord(value.preview)) return;
  expect(typeof value.artifact.id).toBe('string');
  expect(typeof value.artifact.type).toBe('string');
  expect(isRecord(value.artifact.payload)).toBe(true);
  expect(typeof value.preview.text).toBe('string');
  expect(typeof value.preview.contentType).toBe('string');
  expect(typeof value.preview.truncated).toBe('boolean');
  expect(typeof value.preview.sizeBytes).toBe('number');
}

export function expectGenericWebhookResponse(value: unknown): asserts value is {
  accepted: boolean;
  duplicate: boolean;
  session?: { id: string };
  message?: { id: string; prompt: string };
} {
  expectResponseSchemaField('genericWebhook', 'accepted');
  expectResponseSchemaField('genericWebhook', 'duplicate');
  expectResponseSchemaField('genericWebhook', 'session', 'optional:object');
  expectResponseSchemaField('genericWebhook', 'message', 'optional:object');
  expect(isRecord(value)).toBe(true);
  if (!isRecord(value)) return;
  expect(typeof value.accepted).toBe('boolean');
  expect(typeof value.duplicate).toBe('boolean');
  if (value.session !== undefined) {
    expect(isRecord(value.session)).toBe(true);
    if (isRecord(value.session)) expect(typeof value.session.id).toBe('string');
  }
  if (value.message !== undefined) {
    expect(isRecord(value.message)).toBe(true);
    if (isRecord(value.message)) {
      expect(typeof value.message.id).toBe('string');
      expect(typeof value.message.prompt).toBe('string');
    }
  }
}

export function expectErrorResponse(value: unknown): asserts value is { error: string; message: string } {
  expectResponseSchemaField('error', 'error');
  expectResponseSchemaField('error', 'message');
  expect(isRecord(value)).toBe(true);
  if (!isRecord(value)) return;
  expect(typeof value.error).toBe('string');
  expect(typeof value.message).toBe('string');
}

export function expectCallbacksResponse(value: unknown): asserts value is {
  callbacks: Array<{ id: string; sessionId: string; targetType: string; status: string; attempts: number }>;
} {
  expectResponseSchemaField('callbacks', 'callbacks');
  expect(isRecord(value)).toBe(true);
  const callbacks = isRecord(value) ? value.callbacks : undefined;
  expect(Array.isArray(callbacks)).toBe(true);
  if (!Array.isArray(callbacks)) return;
  for (const callback of callbacks) expectCallbackRecord(callback);
}

export function expectCallbackResponse(value: unknown): asserts value is {
  callback: { id: string; sessionId: string; targetType: string; status: string; attempts: number };
} {
  expectResponseSchemaField('callback', 'callback');
  expect(isRecord(value)).toBe(true);
  const callback = isRecord(value) ? value.callback : undefined;
  expectCallbackRecord(callback);
}

function expectNormalizedEvent(value: unknown): void {
  expect(isRecord(value)).toBe(true);
  if (!isRecord(value)) return;
  expect(typeof value.id).toBe('number');
  expect(typeof value.sessionId).toBe('string');
  expect(typeof value.sequence).toBe('number');
  expect(eventTypes.has(String(value.type))).toBe(true);
  expect(isRecord(value.payload)).toBe(true);
  expect(typeof value.createdAt).toBe('string');
}

function expectSessionRecord(value: unknown): void {
  expect(isRecord(value)).toBe(true);
  if (!isRecord(value)) return;
  expect(typeof value.id).toBe('string');
  expect(typeof value.status).toBe('string');
  expect(typeof value.createdAt).toBe('string');
  expect(typeof value.updatedAt).toBe('string');
  if (value.title !== undefined) expect(typeof value.title).toBe('string');
}

function expectMessageRecord(value: unknown): void {
  expect(isRecord(value)).toBe(true);
  if (!isRecord(value)) return;
  expect(typeof value.id).toBe('string');
  expect(typeof value.sessionId).toBe('string');
  expect(typeof value.sequence).toBe('number');
  expect(typeof value.status).toBe('string');
  expect(typeof value.prompt).toBe('string');
  expect(typeof value.createdAt).toBe('string');
}

function expectCallbackRecord(value: unknown): void {
  expect(isRecord(value)).toBe(true);
  if (!isRecord(value)) return;
  expect(typeof value.id).toBe('string');
  expect(typeof value.sessionId).toBe('string');
  expect(typeof value.targetType).toBe('string');
  expect(typeof value.status).toBe('string');
  expect(typeof value.eventType).toBe('string');
  expect(typeof value.attempts).toBe('number');
  expect(typeof value.maxAttempts).toBe('number');
  expect(typeof value.createdAt).toBe('string');
  expect(typeof value.updatedAt).toBe('string');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function expectResponseSchemaField(
  schemaName: PublicApiResponseSchemaName,
  field: string,
  expectedType?: PublicApiResponseField,
): void {
  const fields: Record<string, PublicApiResponseField> = publicApiResponseSchemas[schemaName].fields;
  expect(fields).toHaveProperty(field);
  if (expectedType) expect(fields[field]).toBe(expectedType);
}
