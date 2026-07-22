import { planSessionEvent, type DetailResource, type SessionPresentationEffect } from './session-event-plan.js';
import type { AgentEvent } from './api.js';

const noEffects = [
  'run_started',
  'run_completed',
  'sandbox_starting',
  'sandbox_destroy_failed',
  'sandbox_stop_failed',
  'repository_ready',
  'skills_loaded',
  'skill_invoked',
  'setup_script_started',
  'setup_script_finished',
  'agent_text_delta',
  'agent_response_final',
  'tool_started',
  'tool_finished',
  'notepad_changed',
  'notepad_associations_changed',
];

const cases: Array<{
  types: string[];
  resources?: DetailResource[];
  sessionEffect?: SessionPresentationEffect;
}> = [
  { types: ['session_created', 'session_archived', 'session_unarchived'], sessionEffect: 'list' },
  {
    types: ['session_spawned', 'session_queue_paused', 'session_queue_resumed'],
    sessionEffect: 'summary',
  },
  {
    types: ['message_created', 'message_started', 'message_completed', 'message_failed', 'message_cancelled'],
    resources: ['messages'],
    sessionEffect: 'summary',
  },
  { types: ['message_updated'], resources: ['messages'] },
  {
    types: ['run_cancel_requested', 'run_cancelled', 'run_failed'],
    resources: ['messages'],
    sessionEffect: 'summary',
  },
  { types: ['sandbox_keepalive_extended'], resources: ['services'], sessionEffect: 'summary' },
  {
    types: ['callback_sent', 'callback_retry_scheduled', 'callback_failed', 'callback_replay_requested'],
    resources: ['callbacks'],
  },
  { types: noEffects },
];

describe('planSessionEvent', () => {
  it.each(cases.flatMap((item) => item.types.map((type) => ({ ...item, type }))))(
    'plans $type explicitly',
    ({ type, resources = [], sessionEffect = 'none' }) => {
      const result = planSessionEvent(event(type));

      expect([...result.detailResources]).toEqual(resources);
      expect(result.sessionEffect).toBe(sessionEffect);
      expect(result.directActions).toEqual([]);
    },
  );

  it('reconciles services for session context snapshots only', () => {
    expect([...planSessionEvent(event('session_updated', { title: 'Renamed' })).detailResources]).toEqual([]);
    expect([...planSessionEvent(event('session_updated', { context: null })).detailResources]).toEqual(['services']);
    expect(planSessionEvent(event('session_updated')).sessionEffect).toBe('summary');
  });

  it.each(['sandbox_stopped', 'sandbox_destroyed'])('clears services directly for %s', (type) => {
    const result = planSessionEvent(event(type));

    expect([...result.detailResources]).toEqual([]);
    expect(result.sessionEffect).toBe('summary');
    expect(result.directActions).toEqual([{ type: 'clearServices' }]);
  });

  it('clears stale services when a sandbox is created or restarted', () => {
    expect(planSessionEvent(event('sandbox_ready', { created: true })).directActions).toEqual([
      { type: 'clearServices' },
    ]);
    expect(planSessionEvent(event('sandbox_ready', { restarted: true })).directActions).toEqual([
      { type: 'clearServices' },
    ]);
    expect(planSessionEvent(event('sandbox_ready')).directActions).toEqual([]);
  });

  it('upserts complete artifact payloads owned by the event session', () => {
    const artifact = {
      id: 'artifact-1',
      sessionId: 'session-1',
      type: 'image',
      payload: { contentType: 'image/png' },
      createdAt: '2026-07-20T12:00:00.000Z',
    };

    const result = planSessionEvent(event('artifact_created', { artifact }));

    expect([...result.detailResources]).toEqual([]);
    expect(result.directActions).toEqual([{ type: 'upsertArtifact', artifact }]);
  });

  it.each([
    undefined,
    { id: 'artifact-1' },
    {
      id: 'artifact-1',
      sessionId: 'another-session',
      type: 'image',
      payload: {},
      createdAt: '2026-07-20T12:00:00.000Z',
    },
  ])('falls back to artifact reconciliation for an invalid payload', (artifact) => {
    const result = planSessionEvent(event('artifact_created', { artifact }));

    expect([...result.detailResources]).toEqual(['artifacts']);
    expect(result.directActions).toEqual([]);
  });

  it('upserts complete external resource payloads owned by the event session', () => {
    const resource = {
      id: 'resource-1',
      sessionId: 'session-1',
      type: 'pull_request',
      url: 'https://example.com/pull/1',
      metadata: { number: 1 },
      createdAt: '2026-07-20T12:00:00.000Z',
    };

    const result = planSessionEvent(event('external_resource_created', { resource }));

    expect([...result.detailResources]).toEqual([]);
    expect(result.directActions).toEqual([{ type: 'upsertExternalResource', resource }]);
  });

  it('falls back to external resource reconciliation for an invalid payload', () => {
    const result = planSessionEvent(
      event('external_resource_created', {
        resource: {
          id: 'resource-1',
          sessionId: 'session-1',
          type: 'pull_request',
          url: 'https://example.com/pull/1',
          createdAt: '2026-07-20T12:00:00.000Z',
        },
      }),
    );

    expect([...result.detailResources]).toEqual(['externalResources']);
    expect(result.directActions).toEqual([]);
  });

  it('returns no effects for unknown event types', () => {
    expect(planSessionEvent(event('future_event'))).toEqual({
      detailResources: new Set(),
      sessionEffect: 'none',
      directActions: [],
    });
  });
});

function event(type: string, payload: Record<string, unknown> = {}): AgentEvent {
  return {
    sessionId: 'session-1',
    sequence: 1,
    type,
    payload,
    createdAt: '2026-07-20T12:00:00.000Z',
  };
}
