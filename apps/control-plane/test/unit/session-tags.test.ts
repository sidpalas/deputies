import { normalizeAppendInput } from '../../src/events/service.js';
import { normalizeSessionTags } from '../../src/sessions/tags.js';
import { MemoryStore } from '../../src/store/memory.js';
import { defaultGroupId, type SessionRecord } from '../../src/store/types.js';
import { defineSessionTagsStoreContract } from '../support/session-tags-store-contract.js';

const baseTime = new Date('2026-07-08T00:00:00.000Z');
const otherGroupId = '00000000-0000-4000-8000-000000000202';

describe('session tags and filters', () => {
  it('paginates direct children and counts children matching the list filters', async () => {
    const store = new MemoryStore();
    const parent = await store.createSession(
      session({ id: '00000000-0000-4000-8000-000000000011', tags: ['infra'], lastActivityAt: at(1) }),
    );
    const firstChild = await store.createSession(
      session({
        id: '00000000-0000-4000-8000-000000000012',
        parentSessionId: parent.id,
        tags: ['infra'],
        lastActivityAt: at(3),
      }),
    );
    await store.createSession(
      session({
        id: '00000000-0000-4000-8000-000000000013',
        parentSessionId: parent.id,
        tags: ['other'],
        lastActivityAt: at(2),
      }),
    );

    const parentPage = await store.listSessionsWithLatestSandbox('fake', {
      archived: false,
      tags: ['infra'],
      limit: 10,
    });
    expect(parentPage.items.find(({ session }) => session.id === parent.id)?.directChildCount).toBe(1);

    const childPage = await store.listSessionsWithLatestSandbox('fake', {
      archived: false,
      parentSessionId: parent.id,
      limit: 1,
    });
    expect(childPage.items.map(({ session }) => session.id)).toEqual([firstChild.id]);
    expect(childPage.nextCursor).not.toBeNull();
    const secondPage = await store.listSessionsWithLatestSandbox('fake', {
      archived: false,
      parentSessionId: parent.id,
      limit: 1,
      cursor: childPage.nextCursor!,
    });
    expect(secondPage.items.map(({ session }) => session.id)).toEqual(['00000000-0000-4000-8000-000000000013']);
  });

  it('normalizes session tags deterministically', () => {
    expect(normalizeSessionTags([' Infra\n', 'infra', 'Needs\t  Work', '', 'alpha'])).toEqual([
      'alpha',
      'infra',
      'needs work',
    ]);
  });

  it('rejects invalid session tags', () => {
    expect(normalizeSessionTags('infra')).toBeNull();
    expect(normalizeSessionTags(['a,b'])).toBeNull();
    expect(normalizeSessionTags(['x'.repeat(65)])).toBeNull();
    expect(normalizeSessionTags(['bad\u0000line'])).toBeNull();
    expect(normalizeSessionTags(['infra\u200b'])).toBeNull();
    expect(normalizeSessionTags(['infra\u202e'])).toBeNull();
    expect(normalizeSessionTags(Array.from({ length: 21 }, (_, index) => `tag-${index}`))).toBeNull();
  });

  it('filters sessions by tags, creator, participant, and per-user stars', async () => {
    const store = new MemoryStore();
    const first = await store.createSession(
      session({
        id: '00000000-0000-4000-8000-000000000001',
        title: 'First',
        tags: ['infra', 'urgent'],
        createdByUserId: '00000000-0000-4000-8000-000000000101',
        lastActivityAt: at(2),
      }),
    );
    await store.createSession(
      session({
        id: '00000000-0000-4000-8000-000000000002',
        title: 'Second',
        tags: ['infra'],
        createdByUserId: '00000000-0000-4000-8000-000000000102',
        lastActivityAt: at(1),
      }),
    );
    await store.createMessage({
      id: '00000000-0000-4000-8000-000000000301',
      sessionId: first.id,
      sequence: 1,
      status: 'completed',
      prompt: 'hello',
      createdAt: at(3),
      authorUserId: '00000000-0000-4000-8000-000000000103',
    });
    await store.starSession({
      sessionId: first.id,
      userId: '00000000-0000-4000-8000-000000000104',
      now: at(4),
    });

    await expect(listIds(store, { tags: ['infra', 'urgent'] })).resolves.toEqual([first.id]);
    await expect(listIds(store, { createdByUserId: '00000000-0000-4000-8000-000000000101' })).resolves.toEqual([
      first.id,
    ]);
    await expect(listIds(store, { participantUserId: '00000000-0000-4000-8000-000000000103' })).resolves.toEqual([
      first.id,
    ]);
    await expect(listIds(store, { starredByUserId: '00000000-0000-4000-8000-000000000104' })).resolves.toEqual([
      first.id,
    ]);
    await expect(listIds(store, { starredByUserId: '00000000-0000-4000-8000-000000000105' })).resolves.toEqual([]);
  });

  it('counts visible tags and orders sessions by last activity', async () => {
    const store = new MemoryStore();
    await store.createSession(
      session({
        id: '00000000-0000-4000-8000-000000000011',
        tags: ['infra'],
        visibility: 'organization',
        lastActivityAt: at(1),
        updatedAt: at(9),
      }),
    );
    await store.createSession(
      session({
        id: '00000000-0000-4000-8000-000000000012',
        tags: ['infra', 'secret'],
        ownerGroupId: otherGroupId,
        visibility: 'group',
        lastActivityAt: at(5),
        updatedAt: at(1),
      }),
    );

    await expect(listIds(store, {})).resolves.toEqual([
      '00000000-0000-4000-8000-000000000012',
      '00000000-0000-4000-8000-000000000011',
    ]);
    await expect(store.listSessionTags({ visibleTo: { groupIds: [defaultGroupId] }, limit: 10 })).resolves.toEqual([
      { tag: 'infra', sessionCount: 1 },
    ]);
  });

  it('preserves current tags when committing a non-tag session update', async () => {
    const store = new MemoryStore();
    const created = await store.createSession(session({ id: '00000000-0000-4000-8000-000000000021' }));
    await store.updateSession({
      ...created,
      status: 'active',
      context: { retained: true },
      lastActivityAt: at(3),
      tags: ['infra'],
      updatedAt: at(1),
    });

    const { session: updated } = await store.updateSessionWithEvent(
      { ...created, title: 'Renamed', updatedAt: at(2) },
      normalizeAppendInput({
        sessionId: created.id,
        type: 'session_updated',
        payload: { title: 'Renamed' },
      }),
      { preserveTags: true },
    );

    expect(updated).toMatchObject({
      status: 'active',
      title: 'Renamed',
      tags: ['infra'],
      context: { retained: true },
    });
    expect(updated.lastActivityAt).toEqual(at(3));
  });
});

defineSessionTagsStoreContract(() => new MemoryStore());

function at(minutes: number): Date {
  return new Date(baseTime.getTime() + minutes * 60_000);
}

function session(input: Partial<SessionRecord> & { id: string }): SessionRecord {
  const createdAt = input.createdAt ?? baseTime;
  const updatedAt = input.updatedAt ?? createdAt;
  return {
    status: 'idle',
    spawnDepth: 0,
    ownerGroupId: defaultGroupId,
    visibility: 'organization',
    writePolicy: 'group_members',
    createdAt,
    updatedAt,
    lastActivityAt: input.lastActivityAt ?? updatedAt,
    tags: [],
    ...input,
  };
}

async function listIds(
  store: MemoryStore,
  filters: {
    tags?: string[];
    createdByUserId?: string;
    participantUserId?: string;
    starredByUserId?: string;
  },
): Promise<string[]> {
  const page = await store.listSessionsWithLatestSandbox('fake', { archived: false, limit: 10, ...filters });
  return page.items.map(({ session: item }) => item.id);
}
