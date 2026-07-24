import type { AgentEvent, Artifact, ExternalResource } from './api.js';

export type DetailResource = 'messages' | 'artifacts' | 'services' | 'externalResources' | 'callbacks' | 'followUps';

export type SessionPresentationEffect = 'none' | 'summary' | 'list';

export type DirectSessionAction =
  | { type: 'upsertArtifact'; artifact: Artifact }
  | { type: 'upsertExternalResource'; resource: ExternalResource }
  | { type: 'clearServices' };

export type SessionEventPlan = {
  detailResources: ReadonlySet<DetailResource>;
  sessionEffect: SessionPresentationEffect;
  directActions: readonly DirectSessionAction[];
};

export function planSessionEvent(event: AgentEvent): SessionEventPlan {
  switch (event.type) {
    case 'session_created':
      return plan([], 'list');
    case 'session_archived':
      return plan(['followUps'], 'list');
    case 'session_unarchived':
    case 'session_visibility_changed':
      return plan([], 'list');
    case 'session_spawned':
    case 'session_queue_paused':
    case 'session_queue_resumed':
      return plan([], 'summary');
    case 'session_updated':
      return plan(hasOwn(event.payload, 'context') ? ['services'] : [], 'summary');
    case 'message_created':
    case 'message_started':
    case 'message_completed':
    case 'message_failed':
    case 'message_cancelled':
      return plan(['messages'], 'summary');
    case 'message_updated':
      return plan(['messages']);
    case 'run_cancel_requested':
    case 'run_cancelled':
    case 'run_failed':
      return plan(['messages'], 'summary');
    case 'sandbox_ready':
      return plan(
        [],
        'summary',
        event.payload.created === true || event.payload.restarted === true ? [{ type: 'clearServices' }] : [],
      );
    case 'sandbox_stopped':
    case 'sandbox_destroyed':
      return plan([], 'summary', [{ type: 'clearServices' }]);
    case 'sandbox_keepalive_extended':
      return plan(['services'], 'summary');
    case 'artifact_created': {
      const artifact = artifactFromEvent(event);
      return artifact ? plan([], 'none', [{ type: 'upsertArtifact', artifact }]) : plan(['artifacts']);
    }
    case 'external_resource_created': {
      const resource = externalResourceFromEvent(event);
      return resource ? plan([], 'none', [{ type: 'upsertExternalResource', resource }]) : plan(['externalResources']);
    }
    case 'callback_sent':
    case 'callback_retry_scheduled':
    case 'callback_failed':
    case 'callback_replay_requested':
      return plan(['callbacks']);
    case 'scheduled_follow_up_created':
    case 'scheduled_follow_up_updated':
    case 'scheduled_follow_up_cancelled':
    case 'scheduled_follow_up_completed':
    case 'scheduled_follow_up_occurrence_created':
    case 'scheduled_follow_up_occurrence_skipped':
    case 'scheduled_follow_up_occurrence_failed':
      return plan(['followUps']);
    case 'run_started':
    case 'run_completed':
    case 'sandbox_starting':
    case 'sandbox_destroy_failed':
    case 'sandbox_stop_failed':
    case 'repository_ready':
    case 'skills_loaded':
    case 'skill_invoked':
    case 'setup_script_started':
    case 'setup_script_finished':
    case 'agent_text_delta':
    case 'agent_response_final':
    case 'tool_started':
    case 'tool_finished':
    case 'notepad_changed':
    case 'notepad_associations_changed':
    default:
      return plan([]);
  }
}

function plan(
  detailResources: DetailResource[],
  sessionEffect: SessionPresentationEffect = 'none',
  directActions: DirectSessionAction[] = [],
): SessionEventPlan {
  return { detailResources: new Set(detailResources), sessionEffect, directActions };
}

function artifactFromEvent(event: AgentEvent): Artifact | null {
  const value = event.payload.artifact;
  if (!isRecord(value) || value.sessionId !== event.sessionId) return null;
  if (!hasStrings(value, ['id', 'sessionId', 'type', 'createdAt']) || !isRecord(value.payload)) return null;
  if (!hasOptionalStrings(value, ['title', 'url', 'storageKey', 'runId', 'messageId'])) return null;

  return value as Artifact;
}

function externalResourceFromEvent(event: AgentEvent): ExternalResource | null {
  const value = event.payload.resource;
  if (!isRecord(value) || value.sessionId !== event.sessionId) return null;
  if (!hasStrings(value, ['id', 'sessionId', 'type', 'url', 'createdAt']) || !isRecord(value.metadata)) return null;
  if (!hasOptionalStrings(value, ['title', 'runId', 'messageId'])) return null;

  return value as ExternalResource;
}

function hasStrings(value: Record<string, unknown>, keys: string[]): boolean {
  return keys.every((key) => typeof value[key] === 'string' && value[key].length > 0);
}

function hasOptionalStrings(value: Record<string, unknown>, keys: string[]): boolean {
  return keys.every((key) => value[key] === undefined || typeof value[key] === 'string');
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
