import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { onlineManager } from '@tanstack/react-query';
import { createTestDatabase, type TestSqliteDb } from '@boardsesh/offline-sync/testing';
import { enqueue, runMigrations, stampLocalUserId } from '@boardsesh/offline-sync';
import { readAuthorSnapshot, saveAuthorSnapshot } from '../../../../db/queries/followed-authors-local';
import { loadFollowedAuthors } from '../use-followed-authors';

const request = vi.hoisted(() => vi.fn());
let db: TestSqliteDb;
vi.mock('../../../../db', () => ({ getDatabaseHandle: () => db }));
vi.mock('../../client', () => ({ getHttpClient: () => ({ request }) }));
vi.mock('../../../offline-engine', () => ({ isOfflineEngineEnabled: () => true }));
const oldAuthors = { setterUsernames: ['old-setter'], users: [] };
const newAuthors = { setterUsernames: ['new-setter'], users: [{ userId: 'friend', boardAccounts: [] }] };

beforeEach(async () => {
  db = createTestDatabase();
  await runMigrations(db);
  await stampLocalUserId(db, 'viewer');
  await saveAuthorSnapshot(db, 'viewer', { authors: oldAuthors, incompleteUserIds: [] });
  onlineManager.setOnline(true);
  request.mockReset();
  request.mockResolvedValue({ followedAuthors: newAuthors });
});
afterEach(() => {
  db.close();
  onlineManager.setOnline(true);
});

// These cases own one mutable database fixture; overlap is introduced explicitly
// inside the race tests, not by running separate fixtures concurrently.
describe.sequential('followed author snapshot refresh', () => {
  it('persists successive snapshots without resetting the request generation', async () => {
    for (const setter of ['first', 'second', 'third']) {
      const authors = { setterUsernames: [setter], users: [] };
      request.mockResolvedValueOnce({ followedAuthors: authors });
      expect(await loadFollowedAuthors('viewer')).toEqual(authors);
      expect((await readAuthorSnapshot(db, 'viewer'))?.authors).toEqual(authors);
    }
  });
  it('caches complete board-account metadata and serves it offline', async () => {
    expect(await loadFollowedAuthors('viewer')).toEqual(newAuthors);
    onlineManager.setOnline(false);
    expect(await loadFollowedAuthors('viewer')).toEqual(newAuthors);
    expect(request).toHaveBeenCalledTimes(1);
  });
  it('keeps optimistic follows while their mutations are queued', async () => {
    await enqueue(db, 'setter_follows', 'create', { setterUsername: 'old-setter' }, 'pending-follow');
    expect(await loadFollowedAuthors('viewer')).toEqual(oldAuthors);
    expect((await readAuthorSnapshot(db, 'viewer'))?.authors).toEqual(oldAuthors);
  });
  it('does not overwrite a toggle that raced an older network response', async () => {
    request.mockImplementation(async () => {
      await saveAuthorSnapshot(db, 'viewer', {
        authors: { setterUsernames: ['latest-toggle'], users: [] },
        incompleteUserIds: [],
      });
      return { followedAuthors: newAuthors };
    });
    expect((await loadFollowedAuthors('viewer')).setterUsernames).toEqual(['latest-toggle']);
  });
  it('ignores an older response even when the newer snapshot equals the optimistic cache', async () => {
    let resolveOlder!: (response: { followedAuthors: typeof newAuthors }) => void;
    request.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOlder = resolve;
        }),
    );
    request.mockResolvedValueOnce({ followedAuthors: oldAuthors });
    const older = loadFollowedAuthors('viewer');
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    await loadFollowedAuthors('viewer');
    resolveOlder({ followedAuthors: newAuthors });
    expect(await older).toEqual(oldAuthors);
    expect((await readAuthorSnapshot(db, 'viewer'))?.authors).toEqual(oldAuthors);
  });
  it('does not resurrect another account’s snapshot after sign-out', async () => {
    request.mockImplementation(async () => {
      await stampLocalUserId(db, 'other');
      return { followedAuthors: newAuthors };
    });
    await loadFollowedAuthors('viewer');
    expect(await readAuthorSnapshot(db, 'viewer')).toBeNull();
    const stored = await db.getFirstAsync<{ snapshot: string }>(
      'SELECT snapshot FROM followed_author_snapshots WHERE user_id = ?',
      ['viewer'],
    );
    expect(JSON.parse(stored!.snapshot).authors).toEqual(oldAuthors);
  });
  it('uses the existing snapshot during a transport outage', async () => {
    request.mockRejectedValue(new TypeError('Failed to fetch'));
    expect(await loadFollowedAuthors('viewer')).toEqual(oldAuthors);
  });
  it('refuses another account’s cached follows offline', async () => {
    onlineManager.setOnline(false);
    await expect(loadFollowedAuthors('other')).rejects.toThrow('online sync');
    expect(request).not.toHaveBeenCalled();
  });
});
