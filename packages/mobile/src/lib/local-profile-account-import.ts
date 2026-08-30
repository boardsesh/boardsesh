import { enqueue, getLocalUserId, type OfflineDatabase, type SqlExecutor } from '@boardsesh/offline-sync';
import type { LocalProfileBackupCounts } from './local-profile-backup-core';

type LocalTickImportRow = {
  uuid: string;
  board_type: string;
  climb_uuid: string;
  angle: number;
  is_mirror: number | null;
  status: string;
  attempt_count: number | null;
  quality: number | null;
  difficulty: number | null;
  is_benchmark: number | null;
  comment: string | null;
  climbed_at: string | null;
  created_at: string | null;
  updated_at: string | null;
};

type LocalFavoriteImportRow = {
  board_name: string;
  climb_uuid: string;
  angle: number;
  created_at: string | null;
  updated_at: string | null;
};

type LocalPlaylistImportRow = {
  uuid: string;
  board_type: string;
  layout_id: number;
  name: string;
  description: string | null;
  color: string | null;
  icon: string | null;
  created_at: string | null;
  updated_at: string | null;
  last_accessed_at: string | null;
};

type LocalPlaylistClimbImportRow = {
  playlist_uuid: string;
  climb_uuid: string;
  angle: number | null;
  position: number | null;
  added_at: string | null;
  updated_at: string | null;
};

type LocalProfileImportRows = {
  ticks: LocalTickImportRow[];
  favorites: LocalFavoriteImportRow[];
  playlists: LocalPlaylistImportRow[];
  playlistClimbs: LocalPlaylistClimbImportRow[];
};

async function requireLocalOwner(source: SqlExecutor): Promise<string> {
  const ownerUserId = await getLocalUserId(source);
  if (!ownerUserId?.startsWith('local:')) throw new Error('A ready login-free profile is required to import data');
  return ownerUserId;
}

export async function getLocalProfileImportCounts(source: SqlExecutor): Promise<LocalProfileBackupCounts> {
  const ownerUserId = await requireLocalOwner(source);
  const [ticks, favorites, playlists, playlistClimbs] = await Promise.all([
    source.getFirstAsync<{ count: number }>('SELECT COUNT(*) AS count FROM boardsesh_ticks WHERE user_id = ?', [
      ownerUserId,
    ]),
    source.getFirstAsync<{ count: number }>('SELECT COUNT(*) AS count FROM user_favorites WHERE user_id = ?', [
      ownerUserId,
    ]),
    source.getFirstAsync<{ count: number }>('SELECT COUNT(*) AS count FROM playlists WHERE is_public = 0'),
    source.getFirstAsync<{ count: number }>(
      `SELECT COUNT(*) AS count FROM playlist_climbs
       WHERE EXISTS (SELECT 1 FROM playlists WHERE playlists.uuid = playlist_climbs.playlist_uuid AND is_public = 0)`,
    ),
  ]);
  return {
    ticks: ticks?.count ?? 0,
    favorites: favorites?.count ?? 0,
    playlists: playlists?.count ?? 0,
    playlistClimbs: playlistClimbs?.count ?? 0,
  };
}

async function readImportRows(source: OfflineDatabase): Promise<LocalProfileImportRows> {
  const outcome: { rows: LocalProfileImportRows | null } = { rows: null };
  await source.withExclusiveTransactionAsync(async (snapshot) => {
    const ownerUserId = await requireLocalOwner(snapshot);
    outcome.rows = {
      ticks: await snapshot.getAllAsync<LocalTickImportRow>(
        `SELECT uuid, board_type, climb_uuid, angle, is_mirror, status, attempt_count, quality,
                difficulty, is_benchmark, comment, climbed_at, created_at, updated_at
         FROM boardsesh_ticks WHERE user_id = ? ORDER BY created_at, uuid`,
        [ownerUserId],
      ),
      favorites: await snapshot.getAllAsync<LocalFavoriteImportRow>(
        `SELECT board_name, climb_uuid, angle, created_at, updated_at
         FROM user_favorites WHERE user_id = ? ORDER BY created_at, board_name, climb_uuid, angle`,
        [ownerUserId],
      ),
      playlists: await snapshot.getAllAsync<LocalPlaylistImportRow>(
        `SELECT uuid, board_type, layout_id, name, description, color, icon, created_at, updated_at, last_accessed_at
         FROM playlists WHERE is_public = 0 ORDER BY created_at, uuid`,
      ),
      playlistClimbs: await snapshot.getAllAsync<LocalPlaylistClimbImportRow>(
        `SELECT playlist_uuid, climb_uuid, angle, position, added_at, updated_at
         FROM playlist_climbs
         WHERE EXISTS (
           SELECT 1 FROM playlists WHERE playlists.uuid = playlist_climbs.playlist_uuid AND is_public = 0
         )
         ORDER BY playlist_uuid, position, climb_uuid`,
      ),
    };
  });
  if (outcome.rows === null) throw new Error('The login-free profile snapshot did not finish');
  return outcome.rows;
}

function optionalPayload(fields: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(fields).filter(([, fieldValue]) => fieldValue !== null));
}

/**
 * Copies personal rows into the account database and queues their normal GraphQL
 * mutations. The login-free database is read-only and remains available if the
 * climber switches back later.
 */
export async function importLocalProfileIntoAccount(
  source: OfflineDatabase,
  destination: OfflineDatabase,
  destinationUserId: string,
): Promise<LocalProfileBackupCounts> {
  const rows = await readImportRows(source);
  const outcome: { counts: LocalProfileBackupCounts | null } = { counts: null };

  await destination.withExclusiveTransactionAsync(async (transaction) => {
    const stampedDestinationUserId = await getLocalUserId(transaction);
    if (stampedDestinationUserId !== destinationUserId || destinationUserId.startsWith('local:')) {
      throw new Error('The account database owner is not ready for a login-free import');
    }

    const counts: LocalProfileBackupCounts = { ticks: 0, favorites: 0, playlists: 0, playlistClimbs: 0 };
    const eligiblePlaylistUuids = new Set<string>();

    for (const tick of rows.ticks) {
      const inserted = await transaction.runAsync(
        `INSERT OR IGNORE INTO boardsesh_ticks
           (uuid, user_id, board_type, climb_uuid, angle, is_mirror, status, attempt_count, quality,
            difficulty, is_benchmark, comment, climbed_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          tick.uuid,
          destinationUserId,
          tick.board_type,
          tick.climb_uuid,
          tick.angle,
          tick.is_mirror ?? 0,
          tick.status,
          tick.attempt_count ?? 1,
          tick.quality,
          tick.difficulty,
          tick.is_benchmark ?? 0,
          tick.comment ?? '',
          tick.climbed_at ?? tick.created_at ?? new Date(0).toISOString(),
          tick.created_at,
          tick.updated_at,
        ],
      );
      if (inserted.changes === 0) continue;
      counts.ticks += 1;
      await enqueue(
        transaction,
        'boardsesh_ticks',
        'create',
        optionalPayload({
          boardType: tick.board_type,
          climbUuid: tick.climb_uuid,
          angle: tick.angle,
          isMirror: tick.is_mirror === 1,
          status: tick.status,
          attemptCount: tick.attempt_count ?? 1,
          quality: tick.quality,
          difficulty: tick.difficulty,
          isBenchmark: tick.is_benchmark === 1,
          comment: tick.comment ?? '',
          climbedAt: tick.climbed_at ?? tick.created_at ?? new Date(0).toISOString(),
        }),
        tick.uuid,
      );
    }

    for (const favorite of rows.favorites) {
      const inserted = await transaction.runAsync(
        `INSERT OR IGNORE INTO user_favorites
           (board_name, climb_uuid, angle, user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
        [
          favorite.board_name,
          favorite.climb_uuid,
          favorite.angle,
          destinationUserId,
          favorite.created_at,
          favorite.updated_at,
        ],
      );
      if (inserted.changes === 0) continue;
      counts.favorites += 1;
      const payload = {
        boardName: favorite.board_name,
        climbUuid: favorite.climb_uuid,
        angle: favorite.angle,
      };
      await enqueue(
        transaction,
        'user_favorites',
        'create',
        payload,
        `add:user_favorites:${favorite.board_name}:${favorite.climb_uuid}:${favorite.angle}`,
      );
    }

    for (const playlist of rows.playlists) {
      const existing = await transaction.getFirstAsync<{
        board_type: string;
        layout_id: number;
        name: string;
      }>('SELECT board_type, layout_id, name FROM playlists WHERE uuid = ?', [playlist.uuid]);
      const inserted = await transaction.runAsync(
        `INSERT OR IGNORE INTO playlists
           (uuid, board_type, layout_id, name, description, is_public, color, icon,
            created_at, updated_at, last_accessed_at)
         VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)`,
        [
          playlist.uuid,
          playlist.board_type,
          playlist.layout_id,
          playlist.name,
          playlist.description,
          playlist.color,
          playlist.icon,
          playlist.created_at,
          playlist.updated_at,
          playlist.last_accessed_at,
        ],
      );
      const sameExistingPlaylist =
        existing?.board_type === playlist.board_type &&
        existing.layout_id === playlist.layout_id &&
        existing.name === playlist.name;
      if (inserted.changes > 0) {
        counts.playlists += 1;
        await enqueue(
          transaction,
          'playlists',
          'create',
          optionalPayload({
            boardType: playlist.board_type,
            layoutId: playlist.layout_id,
            name: playlist.name,
            description: playlist.description,
            color: playlist.color,
            icon: playlist.icon,
          }),
          playlist.uuid,
        );
      }
      if (inserted.changes > 0 || sameExistingPlaylist) eligiblePlaylistUuids.add(playlist.uuid);
    }

    for (const playlistClimb of rows.playlistClimbs) {
      if (!eligiblePlaylistUuids.has(playlistClimb.playlist_uuid) || playlistClimb.angle === null) continue;
      const inserted = await transaction.runAsync(
        `INSERT OR IGNORE INTO playlist_climbs
           (playlist_uuid, climb_uuid, angle, position, added_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
        [
          playlistClimb.playlist_uuid,
          playlistClimb.climb_uuid,
          playlistClimb.angle,
          playlistClimb.position,
          playlistClimb.added_at,
          playlistClimb.updated_at,
        ],
      );
      if (inserted.changes === 0) continue;
      counts.playlistClimbs += 1;
      await enqueue(
        transaction,
        'playlist_climbs',
        'create',
        {
          playlistId: playlistClimb.playlist_uuid,
          climbUuid: playlistClimb.climb_uuid,
          angle: playlistClimb.angle,
        },
        `add:playlist_climbs:${playlistClimb.playlist_uuid}:${playlistClimb.climb_uuid}`,
      );
    }

    outcome.counts = counts;
  });

  if (outcome.counts === null) throw new Error('The account import transaction did not finish');
  return outcome.counts;
}
