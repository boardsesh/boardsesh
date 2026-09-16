import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDatabase, type TestSqliteDb } from '@boardsesh/offline-sync/testing';
import { runMigrations, stampLocalUserId } from '@boardsesh/offline-sync';
import {
  canReadFollowedAuthors,
  readAuthorSnapshot,
  saveAuthorSnapshot,
  updateAuthorSnapshot,
  type AuthorSnapshot,
} from '../followed-authors-local';
import { countClimbsLocal, searchClimbsLocal } from '../search-climbs-local';
import { getSetterStatsLocal } from '../get-setter-stats-local';
import { setterPlaylistInput } from '../../../lib/playlists/setter-playlist-input';

const identity = vi.hoisted(() => ({ userId: 'viewer' as string | undefined }));
vi.mock('../../../lib/local-user-id', () => ({ readLocalUserId: async () => identity.userId }));
const board = { boardName: 'kilter', layoutId: 1, sizeId: 5, setIds: '', angle: 40 };
const snapshot: AuthorSnapshot = {
  authors: {
    setterUsernames: ['unclaimed'],
    users: [{ userId: 'friend', boardAccounts: [{ boardType: 'kilter', username: 'linked' }] }],
  },
  incompleteUserIds: [],
};
let db: TestSqliteDb;
beforeEach(async () => {
  identity.userId = 'viewer';
  db = createTestDatabase();
  await runMigrations(db);
  await stampLocalUserId(db, 'viewer');
  await saveAuthorSnapshot(db, 'viewer', snapshot);
});
afterEach(() => db.close());

async function insertClimb(uuid: string, setter: string, userId: string | null = null, boardType = 'kilter') {
  await db.runAsync(
    `INSERT INTO board_climbs (uuid, board_type, layout_id, name, setter_username, user_id,
    is_listed, is_draft, compatible_size_ids, required_set_ids, frames_count, frames, created_at)
    VALUES (?, ?, 1, ?, ?, ?, 1, 0, '[5]', '[]', 1, '', '2026-09-01')`,
    [uuid, boardType, uuid, setter, userId],
  );
}

describe('offline followed authors', () => {
  it('matches accountless, native and linked authors without duplicates', async () => {
    await insertClimb('accountless', 'unclaimed');
    await insertClimb('native', 'native-setter', 'friend');
    await insertClimb('linked', 'linked');
    await insertClimb('overlap', 'unclaimed', 'friend');
    await insertClimb('stranger', 'stranger');
    const input = { ...board, onlyFollowedAuthors: true };
    expect((await searchClimbsLocal(db, input)).climbs.map((climb) => climb.uuid).sort()).toEqual([
      'accountless',
      'linked',
      'native',
      'overlap',
    ]);
    expect(await countClimbsLocal(db, input)).toBe(4);
    expect((await getSetterStatsLocal(db, input)).map((setter) => setter.setterUsername).sort()).toEqual([
      'linked',
      'native-setter',
      'unclaimed',
    ]);
  });
  it('does not match a linked username on the wrong board', async () => {
    await insertClimb('wrong-board', 'linked', null, 'tension');
    expect(await countClimbsLocal(db, { ...board, boardName: 'tension', onlyFollowedAuthors: true })).toBe(0);
  });
  it('filters before the top-50 setter limit', async () => {
    for (let index = 0; index < 55; index++) await insertClimb(`other-${index}`, `aaa-${index}`);
    await insertClimb('wanted', 'unclaimed');
    expect(await getSetterStatsLocal(db, { ...board, onlyFollowedAuthors: true })).toEqual([
      { setterUsername: 'unclaimed', climbCount: 1 },
    ]);
  });
  it('refuses missing, incomplete, signed-out and previous-account snapshots', async () => {
    expect(await canReadFollowedAuthors(db)).toBe(true);
    identity.userId = 'other';
    expect(await canReadFollowedAuthors(db)).toBe(false);
    await expect(searchClimbsLocal(db, { ...board, onlyFollowedAuthors: true })).rejects.toThrow('online sync');
    identity.userId = undefined;
    expect(await canReadFollowedAuthors(db)).toBe(false);
    identity.userId = 'viewer';
    await saveAuthorSnapshot(db, 'viewer', { ...snapshot, incompleteUserIds: ['unknown'] });
    expect(await canReadFollowedAuthors(db)).toBe(false);
    expect(await readAuthorSnapshot(db, 'other')).toBeNull();
  });
  it('knows the difference between an empty snapshot and unavailable author links', async () => {
    await saveAuthorSnapshot(db, 'viewer', { authors: { setterUsernames: [], users: [] }, incompleteUserIds: [] });
    expect(await canReadFollowedAuthors(db)).toBe(true);
    expect(await countClimbsLocal(db, { ...board, onlyFollowedAuthors: true })).toBe(0);
  });
  it('updates offline follows without inventing board-account links', () => {
    const followed = updateAuthorSnapshot(snapshot, 'setter', 'new-setter', true);
    expect(followed.authors.setterUsernames).toContain('new-setter');
    expect(updateAuthorSnapshot(followed, 'setter', 'new-setter', false).authors).toEqual(snapshot.authors);
    const unknown = updateAuthorSnapshot(snapshot, 'user', 'unknown', true);
    expect(unknown.incompleteUserIds).toEqual(['unknown']);
    expect(updateAuthorSnapshot(unknown, 'user', 'unknown', false)).toEqual(snapshot);
    expect(updateAuthorSnapshot(snapshot, 'user', 'friend', true).incompleteUserIds).toEqual([]);
  });
  it('opens a setter playlist without inheriting grade, name or following filters', () => {
    const input = setterPlaylistInput('unclaimed', {
      ...board,
      name: 'old search',
      minGrade: 30,
      onlyFollowedAuthors: true,
    } as typeof board);
    expect(input).toEqual({
      ...board,
      setter: ['unclaimed'],
      sortBy: 'creation',
      sortOrder: 'desc',
      boulders: true,
      routes: true,
    });
  });
});
