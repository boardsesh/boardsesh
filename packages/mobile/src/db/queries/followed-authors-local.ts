import { assertLocalUserDataOwner, type OfflineDatabase, type SqlExecutor } from '@boardsesh/offline-sync';
import type { FollowedAuthors } from '@boardsesh/shared-schema';
import { FollowedAuthorsUnavailableError } from '../../lib/followed-authors-error';

export type AuthorSnapshot = { authors: FollowedAuthors; incompleteUserIds: string[]; complete?: boolean };

export async function readAuthorSnapshot(db: SqlExecutor, userId: string): Promise<AuthorSnapshot | null> {
  if ((await assertLocalUserDataOwner(db, userId)) !== 'ok') return null;
  const row = await db.getFirstAsync<{ snapshot: string }>(
    'SELECT snapshot FROM followed_author_snapshots WHERE user_id = ?',
    [userId],
  );
  return row ? (JSON.parse(row.snapshot) as AuthorSnapshot) : null;
}

export async function saveAuthorSnapshot(db: SqlExecutor, userId: string, snapshot: AuthorSnapshot) {
  await db.runAsync('INSERT OR REPLACE INTO followed_author_snapshots (user_id, snapshot) VALUES (?, ?)', [
    userId,
    JSON.stringify(snapshot),
  ]);
}

/** Unknown offline user links must not silently look like an empty catalogue. */
export async function canReadFollowedAuthors(db: SqlExecutor): Promise<boolean> {
  const { readLocalUserId } = await import('../../lib/local-user-id');
  const userId = await readLocalUserId();
  const snapshot = userId ? await readAuthorSnapshot(db, userId) : null;
  return snapshot !== null && snapshot.complete !== false && snapshot.incompleteUserIds.length === 0;
}

export async function followedAuthorsLocalCondition(db: OfflineDatabase): Promise<{ sql: string; binds: string[] }> {
  const { readLocalUserId } = await import('../../lib/local-user-id');
  const userId = await readLocalUserId();
  const snapshot = userId ? await readAuthorSnapshot(db, userId) : null;
  if (!snapshot || snapshot.complete === false || snapshot.incompleteUserIds.length > 0)
    throw new FollowedAuthorsUnavailableError();
  return {
    sql: `(c.setter_username IN (SELECT value FROM json_each(?)) OR EXISTS (
      SELECT 1 FROM json_each(?) author
      WHERE json_extract(author.value, '$.userId') = c.user_id OR EXISTS (
        SELECT 1 FROM json_each(author.value, '$.boardAccounts') account
        WHERE json_extract(account.value, '$.boardType') = c.board_type
          AND json_extract(account.value, '$.username') = c.setter_username
      )
    ))`,
    binds: [JSON.stringify(snapshot.authors.setterUsernames), JSON.stringify(snapshot.authors.users)],
  };
}

export function updateAuthorSnapshot(
  snapshot: AuthorSnapshot,
  kind: 'setter' | 'user',
  identifier: string,
  follow: boolean,
): AuthorSnapshot {
  const setterUsernames = new Set(snapshot.authors.setterUsernames);
  const users = new Map(snapshot.authors.users.map((user) => [user.userId, user]));
  const incomplete = new Set(snapshot.incompleteUserIds);
  if (kind === 'setter') {
    if (follow) setterUsernames.add(identifier);
    else setterUsernames.delete(identifier);
  } else if (follow && !users.has(identifier)) {
    users.set(identifier, { userId: identifier, boardAccounts: [] });
    incomplete.add(identifier);
  } else if (!follow) {
    users.delete(identifier);
    incomplete.delete(identifier);
  }
  return {
    ...snapshot,
    authors: { setterUsernames: [...setterUsernames], users: [...users.values()] },
    incompleteUserIds: [...incomplete],
  };
}
