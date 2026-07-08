import { describe, expect, it } from 'vitest';
import { createServices } from '../../src/app/server.js';
import { defaultGroupId, type AppStore, type SessionRecord } from '../../src/store/types.js';

const baseTime = new Date('2026-07-08T00:00:00.000Z');
const groupId = '00000000-0000-4000-8000-000000000202';
const otherGroupId = '00000000-0000-4000-8000-000000000203';
const userAId = '00000000-0000-4000-8000-000000000301';
const userBId = '00000000-0000-4000-8000-000000000302';
const userCId = '00000000-0000-4000-8000-000000000303';

export function defineSessionTagsStoreContract(getStore: () => AppStore): void {
  describe('session tags, stars, filters, and activity store contract', () => {
    it('round-trips tags and filters by tags, group, archive state, creator, participant, and stars', async () => {
      const store = getStore();
      await seedUsersAndGroups(store);
      const first = await store.createSession(
        session({
          id: '00000000-0000-4000-8000-000000000401',
          title: 'First',
          ownerGroupId: groupId,
          tags: ['infra', 'urgent'],
          createdByUserId: userAId,
          lastActivityAt: at(4),
        }),
      );
      const second = await store.createSession(
        session({
          id: '00000000-0000-4000-8000-000000000402',
          title: 'Second',
          ownerGroupId: groupId,
          tags: ['infra'],
          createdByUserId: userBId,
          lastActivityAt: at(3),
        }),
      );
      const archived = await store.createSession(
        session({
          id: '00000000-0000-4000-8000-000000000403',
          title: 'Archived',
          status: 'archived',
          ownerGroupId: groupId,
          tags: ['infra', 'urgent'],
          lastActivityAt: at(2),
        }),
      );
      await store.createSession(
        session({
          id: '00000000-0000-4000-8000-000000000404',
          title: 'Other group',
          ownerGroupId: otherGroupId,
          tags: ['infra', 'urgent'],
          lastActivityAt: at(1),
        }),
      );

      await store.createMessage({
        id: '00000000-0000-4000-8000-000000000501',
        sessionId: first.id,
        sequence: 1,
        status: 'completed',
        prompt: 'participant message',
        authorUserId: userCId,
        createdAt: at(5),
      });
      await store.starSession({ sessionId: first.id, userId: userAId, now: at(6) });
      await store.starSession({ sessionId: second.id, userId: userBId, now: at(6) });
      await store.starSession({ sessionId: second.id, userId: userBId, now: at(7) });

      await expect(listIds(store, { archived: false, tags: ['infra'] })).resolves.toEqual([
        first.id,
        second.id,
        '00000000-0000-4000-8000-000000000404',
      ]);
      await expect(listIds(store, { archived: false, tags: ['infra', 'urgent'] })).resolves.toEqual([
        first.id,
        '00000000-0000-4000-8000-000000000404',
      ]);
      await expect(listIds(store, { archived: false, tags: ['infra', 'urgent'], groupId })).resolves.toEqual([
        first.id,
      ]);
      await expect(listIds(store, { archived: true, tags: ['infra', 'urgent'], groupId })).resolves.toEqual([
        archived.id,
      ]);
      await expect(listIds(store, { archived: false, createdByUserId: userAId })).resolves.toEqual([first.id]);
      await expect(listIds(store, { archived: false, participantUserId: userCId })).resolves.toEqual([first.id]);
      await expect(listIds(store, { archived: false, participantUserId: userBId })).resolves.toEqual([]);
      await expect(listIds(store, { archived: false, starredByUserId: userAId })).resolves.toEqual([first.id]);
      await expect(listIds(store, { archived: false, starredByUserId: userBId })).resolves.toEqual([second.id]);

      await store.unstarSession({ sessionId: second.id, userId: userBId });
      await store.unstarSession({ sessionId: second.id, userId: userBId });
      await expect(listIds(store, { archived: false, starredByUserId: userBId })).resolves.toEqual([]);

      const updated = await store.updateSession({ ...first, tags: ['review'], updatedAt: at(8) });
      expect(updated.tags).toEqual(['review']);
      await expect(store.getSession(first.id)).resolves.toMatchObject({ tags: ['review'] });
    });

    it('keeps pagination stable under tag filters', async () => {
      const store = getStore();
      await seedUsersAndGroups(store);
      const sessions = await Promise.all(
        [0, 1, 2].map((index) =>
          store.createSession(
            session({
              id: `00000000-0000-4000-8000-00000000051${index}`,
              title: `Paged ${index}`,
              ownerGroupId: groupId,
              tags: ['paged'],
              lastActivityAt: at(index),
            }),
          ),
        ),
      );

      let cursor: Awaited<ReturnType<AppStore['listSessionsWithLatestSandbox']>>['nextCursor'] | undefined;
      const seen: string[] = [];
      for (;;) {
        const page = await store.listSessionsWithLatestSandbox('fake', {
          archived: false,
          tags: ['paged'],
          limit: 1,
          ...(cursor ? { cursor } : {}),
        });
        seen.push(...page.items.map(({ session: item }) => item.id));
        if (!page.nextCursor) break;
        cursor = page.nextCursor;
      }

      expect(seen).toHaveLength(sessions.length);
      expect(new Set(seen)).toEqual(new Set(sessions.map((item) => item.id)));
    });

    it('counts only visible tags', async () => {
      const store = getStore();
      await seedUsersAndGroups(store);
      await store.createSession(
        session({
          id: '00000000-0000-4000-8000-000000000601',
          tags: ['shared'],
          visibility: 'organization',
          ownerGroupId: otherGroupId,
        }),
      );
      await store.createSession(
        session({
          id: '00000000-0000-4000-8000-000000000602',
          tags: ['private'],
          visibility: 'group',
          ownerGroupId: groupId,
        }),
      );
      await store.createSession(
        session({
          id: '00000000-0000-4000-8000-000000000603',
          tags: ['private'],
          visibility: 'group',
          ownerGroupId: otherGroupId,
        }),
      );

      await expect(store.listSessionTags({ visibleTo: { groupIds: [groupId] }, limit: 10 })).resolves.toEqual([
        { tag: 'private', sessionCount: 1 },
        { tag: 'shared', sessionCount: 1 },
      ]);
    });

    it('bumps activity for message, run, and queue writes but not metadata updates', async () => {
      const store = getStore();
      await seedUsersAndGroups(store);
      const services = createServices(store);
      const created = await store.createSession(
        session({
          id: '00000000-0000-4000-8000-000000000701',
          title: 'Activity',
          ownerGroupId: groupId,
          lastActivityAt: at(1),
        }),
      );
      const originalActivity = created.lastActivityAt;

      await store.updateSession({
        ...created,
        status: 'active',
        context: { retained: true },
        lastActivityAt: originalActivity,
      });
      const updated = await store.updateSessionMetadataWithEvent({
        id: created.id,
        title: 'Metadata only',
        tags: ['metadata'],
        updatedAt: at(10),
      });
      expect(updated.session).toMatchObject({
        status: 'active',
        title: 'Metadata only',
        tags: ['metadata'],
        context: { retained: true },
      });
      expect(updated.session.lastActivityAt).toEqual(originalActivity);

      await services.messages.enqueue({ sessionId: created.id, prompt: 'activity bump', authorUserId: userAId });
      const afterMessage = await requireSession(store, created.id);
      expect(afterMessage.lastActivityAt.getTime()).toBeGreaterThan(originalActivity.getTime());

      const claimed = await store.claimNextPendingMessageBatch({
        runId: '00000000-0000-4000-8000-000000000801',
        runnerType: 'contract',
        leaseOwner: 'contract-worker',
        leaseExpiresAt: at(20),
        now: at(11),
      });
      expect(claimed?.run.sessionId).toBe(created.id);
      const afterClaim = await requireSession(store, created.id);
      expect(afterClaim.lastActivityAt).toEqual(at(11));

      await store.pauseSessionQueue({ sessionId: created.id, pausedAt: at(12) });
      const afterPause = await requireSession(store, created.id);
      expect(afterPause.lastActivityAt).toEqual(at(12));
    });
  });
}

async function seedUsersAndGroups(store: AppStore): Promise<void> {
  const now = baseTime;
  await Promise.all([
    ensureGroup(store, groupRecord(groupId, 'Contract group', now)),
    ensureGroup(store, groupRecord(otherGroupId, 'Other contract group', now)),
    createUser(store, userAId, 'a', now),
    createUser(store, userBId, 'b', now),
    createUser(store, userCId, 'c', now),
  ]);
}

async function ensureGroup(store: AppStore, record: ReturnType<typeof groupRecord>): Promise<void> {
  if (await store.getGroup(record.id)) return;
  await store.createGroup(record);
}

async function createUser(store: AppStore, userId: string, suffix: string, now: Date): Promise<void> {
  await store.upsertAuthUserForAccount({
    userId,
    accountId: `00000000-0000-4000-8000-0000000009${suffix.charCodeAt(0)}`,
    provider: 'contract',
    providerAccountId: suffix,
    username: `contract-${suffix}`,
    role: 'user',
    profile: {},
    now,
  });
}

function groupRecord(id: string, name: string, now: Date) {
  return {
    id,
    name,
    defaultVisibility: 'group' as const,
    defaultWritePolicy: 'group_members' as const,
    automationCreateRequiredRole: 'member' as const,
    createdAt: now,
    updatedAt: now,
  };
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

function at(minutes: number): Date {
  return new Date(baseTime.getTime() + minutes * 60_000);
}

async function listIds(
  store: AppStore,
  options: Omit<Parameters<AppStore['listSessionsWithLatestSandbox']>[1], 'limit'>,
): Promise<string[]> {
  const page = await store.listSessionsWithLatestSandbox('fake', { ...options, limit: 10 });
  return page.items.map(({ session: item }) => item.id);
}

async function requireSession(store: AppStore, sessionId: string): Promise<SessionRecord> {
  const session = await store.getSession(sessionId);
  if (!session) throw new Error(`Expected session ${sessionId}`);
  return session;
}
