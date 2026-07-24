import type { ScheduledFollowUp, ScheduledFollowUpPage } from './api.js';
import {
  appendScheduledFollowUpPage,
  appendScheduledFollowUpPageIfCurrent,
  firstScheduledFollowUpPage,
  mergeScheduledFollowUpFirstPage,
} from './app.js';

function definition(id: string, status: ScheduledFollowUp['status'] = 'active'): ScheduledFollowUp {
  return {
    id,
    sessionId: 'session-1',
    status,
    scheduleKind: 'once',
    prompt: id,
    runAt: '2026-07-25T10:00:00Z',
    definitionRevision: 1,
    createdAt: '2026-07-24T10:00:00Z',
    updatedAt: '2026-07-24T10:00:00Z',
    canManage: true,
  };
}

function page(items: ScheduledFollowUp[], nextCursor?: string): ScheduledFollowUpPage {
  return {
    scheduledFollowUps: items,
    hasMore: Boolean(nextCursor),
    ...(nextCursor ? { nextCursor } : {}),
  };
}

it('appends and deduplicates older scheduled definition pages', () => {
  const first = firstScheduledFollowUpPage(page([definition('new'), definition('overlap')], 'cursor-1'));
  const result = appendScheduledFollowUpPage(first, page([definition('overlap'), definition('old')], 'cursor-2'));

  expect(result.scheduledFollowUps.map((item) => item.id)).toEqual(['new', 'overlap', 'old']);
  expect(result.nextCursor).toBe('cursor-2');
});

it('resets loaded older definitions on an authoritative first-page refresh', () => {
  const first = firstScheduledFollowUpPage(page([definition('first-old')], 'cursor-1'));
  const loaded = appendScheduledFollowUpPage(
    first,
    page([definition('older-active'), definition('older-cancelled', 'cancelled')]),
  );
  const refreshed = mergeScheduledFollowUpFirstPage(loaded, page([definition('first-new')], 'cursor-new'));

  expect(refreshed.scheduledFollowUps.map((item) => item.id)).toEqual(['first-new']);
  expect(refreshed.nextCursor).toBe('cursor-new');
  expect(refreshed.hasMore).toBe(true);
});

it('ignores an older page that resolves after an authoritative reset', () => {
  const capturedVersion = 3;
  const first = firstScheduledFollowUpPage(page([definition('before-reset')], 'same-cursor'));
  const reset = mergeScheduledFollowUpFirstPage(first, page([definition('after-reset')], 'same-cursor'));
  const result = appendScheduledFollowUpPageIfCurrent(
    reset,
    page([definition('stale-older')]),
    'same-cursor',
    capturedVersion,
    capturedVersion + 1,
  );

  expect(result).toBe(reset);
  expect(result.scheduledFollowUps.map((item) => item.id)).toEqual(['after-reset']);
});
