import { describe, expect, it } from 'vitest';
import type { AppStore, CreateSnippetRecord } from '../../src/store/types.js';

const now = new Date('2026-07-20T00:00:00.000Z');
const later = new Date('2026-07-20T01:00:00.000Z');
const userA = '00000000-0000-4000-8000-000000000701';
const userB = '00000000-0000-4000-8000-000000000702';

export function defineSnippetsStoreContract(getStore: () => AppStore): void {
  describe('snippets store contract', () => {
    it('creates, gets, lists, and updates snippets with owner isolation and active-name uniqueness', async () => {
      const store = getStore();
      await seedUsers(store);
      const first = await store.createSnippet(snippet('00000000-0000-4000-8000-000000000711', userA, 'review'));
      const other = await store.createSnippet(snippet('00000000-0000-4000-8000-000000000712', userB, 'review'));

      await expect(store.getSnippetForUser(first.id, userA)).resolves.toEqual(first);
      await expect(store.getSnippetForUser(first.id, userB)).resolves.toBeNull();
      await expect(store.listSnippetsForUser(userA)).resolves.toEqual([first]);
      await expect(store.listSnippetsForUser(userB)).resolves.toEqual([other]);
      await expect(
        store.createSnippet(snippet('00000000-0000-4000-8000-000000000713', userA, 'review')),
      ).rejects.toMatchObject({ code: 'snippet_name_exists' });

      await expect(
        store.updateSnippet({ id: first.id, ownerUserId: userB, name: 'stolen', body: 'No', updatedAt: later }),
      ).resolves.toBeNull();
      const updated = await store.updateSnippet({
        id: first.id,
        ownerUserId: userA,
        name: 'review-updated',
        body: 'Updated body',
        updatedAt: later,
      });
      expect(updated).toMatchObject({ id: first.id, name: 'review-updated', body: 'Updated body', updatedAt: later });

      await Promise.all([
        store.updateSnippet({ id: first.id, ownerUserId: userA, name: 'concurrent-name', updatedAt: later }),
        store.updateSnippet({ id: first.id, ownerUserId: userA, body: 'Concurrent body', updatedAt: later }),
      ]);
      await expect(store.getSnippetForUser(first.id, userA)).resolves.toMatchObject({
        name: 'concurrent-name',
        body: 'Concurrent body',
      });
    });

    it('supports idempotent archive/restore, archived-name reuse, and restore conflicts', async () => {
      const store = getStore();
      await seedUsers(store);
      const original = await store.createSnippet(snippet('00000000-0000-4000-8000-000000000721', userA, 'deploy'));
      const archived = await store.archiveSnippet(original.id, userA, later);
      expect(archived).toMatchObject({ id: original.id, archivedAt: later });
      await expect(store.archiveSnippet(original.id, userA, new Date(later.getTime() + 1000))).resolves.toEqual(
        archived,
      );
      await expect(store.archiveSnippet(original.id, userB, later)).resolves.toBeNull();

      const replacement = await store.createSnippet(snippet('00000000-0000-4000-8000-000000000722', userA, 'deploy'));
      await expect(store.restoreSnippet(original.id, userA, later)).rejects.toMatchObject({
        code: 'snippet_name_exists',
      });
      await store.archiveSnippet(replacement.id, userA, later);
      const restored = await store.restoreSnippet(original.id, userA, later);
      expect(restored).toMatchObject({ id: original.id, name: 'deploy' });
      expect(restored).not.toHaveProperty('archivedAt');
      await expect(store.restoreSnippet(original.id, userA, new Date(later.getTime() + 1000))).resolves.toEqual(
        restored,
      );
      await expect(store.restoreSnippet(original.id, userB, later)).resolves.toBeNull();
    });

    it('returns the requested state from concurrent archive and restore operations', async () => {
      const store = getStore();
      await seedUsers(store);
      const original = await store.createSnippet(snippet('00000000-0000-4000-8000-000000000731', userA, 'lifecycle'));

      const [archived, restored] = await Promise.all([
        store.archiveSnippet(original.id, userA, later),
        store.restoreSnippet(original.id, userA, new Date(later.getTime() + 1000)),
      ]);

      expect(archived?.archivedAt).toBeInstanceOf(Date);
      expect(restored).not.toHaveProperty('archivedAt');
    });
  });
}

async function seedUsers(store: AppStore): Promise<void> {
  for (const [id, username] of [
    [userA, 'snippet-a'],
    [userB, 'snippet-b'],
  ] as const) {
    await store.upsertAuthUserForAccount({
      userId: id,
      accountId: id.replace(/^0/, '1'),
      provider: 'snippets-contract',
      providerAccountId: username,
      username,
      role: 'user',
      profile: {},
      now,
    });
  }
}

function snippet(id: string, ownerUserId: string, name: string): CreateSnippetRecord {
  return { id, ownerUserId, name, body: `${name} body`, createdAt: now, updatedAt: now };
}
