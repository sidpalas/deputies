import { applyFrozenSessionOrder, sortSessionsByLastActivity } from './app-state.js';
import type { Session } from './api.js';

describe('session ordering helpers', () => {
  it('sorts by last activity with created/id tiebreakers', () => {
    const sessions = [
      session('00000000-0000-4000-8000-000000000001', '2026-05-05T12:00:00.000Z'),
      session('00000000-0000-4000-8000-000000000003', '2026-05-05T12:01:00.000Z'),
      session('00000000-0000-4000-8000-000000000002', '2026-05-05T12:01:00.000Z'),
    ];

    expect(sortSessionsByLastActivity(sessions).map((item) => item.id)).toEqual([
      '00000000-0000-4000-8000-000000000003',
      '00000000-0000-4000-8000-000000000002',
      '00000000-0000-4000-8000-000000000001',
    ]);
  });

  it('keeps existing rows frozen and holds newcomers until unfreeze unless appended', () => {
    const oldFirst = session('00000000-0000-4000-8000-000000000001', '2026-05-05T12:00:00.000Z');
    const oldSecond = session('00000000-0000-4000-8000-000000000002', '2026-05-05T12:01:00.000Z');
    const newest = session('00000000-0000-4000-8000-000000000003', '2026-05-05T12:02:00.000Z');

    expect(
      applyFrozenSessionOrder([oldFirst, oldSecond, newest], [oldFirst.id, oldSecond.id], {
        frozen: true,
      }).sessions.map((item) => item.id),
    ).toEqual([oldFirst.id, oldSecond.id]);

    expect(
      applyFrozenSessionOrder([oldFirst, oldSecond, newest], [oldFirst.id, oldSecond.id], {
        frozen: true,
        appendIds: [newest.id],
      }).sessions.map((item) => item.id),
    ).toEqual([oldFirst.id, oldSecond.id, newest.id]);

    expect(
      applyFrozenSessionOrder([oldFirst, oldSecond, newest], [oldFirst.id, oldSecond.id], {
        frozen: false,
      }).sessions.map((item) => item.id),
    ).toEqual([newest.id, oldSecond.id, oldFirst.id]);
  });

  it('can append an archived page while the session order is frozen', () => {
    const active = session('00000000-0000-4000-8000-000000000001', '2026-05-05T12:00:00.000Z');
    const archived = {
      ...session('00000000-0000-4000-8000-000000000004', '2026-05-05T12:03:00.000Z'),
      status: 'archived' as const,
    };

    expect(
      applyFrozenSessionOrder([active, archived], [active.id], { frozen: true, appendIds: [archived.id] }).sessions.map(
        (item) => item.id,
      ),
    ).toEqual([active.id, archived.id]);
  });
});

function session(id: string, lastActivityAt: string): Session {
  return {
    id,
    status: 'idle',
    spawnDepth: 0,
    ownerGroupId: '00000000-0000-4000-8000-000000000010',
    visibility: 'organization',
    writePolicy: 'group_members',
    createdAt: '2026-05-05T12:00:00.000Z',
    updatedAt: '2026-05-05T12:00:00.000Z',
    lastActivityAt,
    tags: [],
  };
}
