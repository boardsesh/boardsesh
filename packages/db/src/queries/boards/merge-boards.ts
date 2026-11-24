import { sql, type SQLWrapper } from 'drizzle-orm';
import { executeRows } from '../../client/index';
import { chooseMetadataDonor, isGenericBoardName, SYSTEM_USER_ID, type SerialBoardRow } from './serial-dedupe';

/** Migration-only operation. Caller owns row/serial locks, validation and transaction. */
export type BoardMergeRow = Omit<SerialBoardRow, 'serialNumber'>;
export type BoardMergeExecuteDb = { execute(query: SQLWrapper | string): PromiseLike<unknown> };
type CountRow = { count: number | string | null };

function sqlNumberList(values: number[]): SQLWrapper {
  return sql.join(
    values.map((value) => sql`${value}`),
    sql`, `,
  );
}
function sqlTextList(values: string[]): SQLWrapper {
  return sql.join(
    values.map((value) => sql`${value}`),
    sql`, `,
  );
}
async function executeCount(commandDb: BoardMergeExecuteDb, query: SQLWrapper): Promise<number> {
  const [row] = await executeRows<CountRow>(commandDb, query);
  return Number(row?.count ?? 0);
}

export type BoardMergeCounts = {
  boardsWithMetadataBackfilled: number;
  climbEventsMoved: number;
  sequenceFloorsAdvanced: number;
  betaLinksMoved: number;
  sessionsMoved: number;
  sessionBoardsInserted: number;
  sessionBoardsDeleted: number;
  ticksMoved: number;
  followsInserted: number;
  followsDeleted: number;
  ownerFollowsInserted: number;
  boardActivityInserted: number;
  boardActivityDeleted: number;
  serialPointersRepointed: number;
  commentsMoved: number;
  votesUpserted: number;
  votesDeleted: number;
  feedItemsEntityMoved: number;
  feedItemsBoardUuidMoved: number;
  notificationsMoved: number;
  tombstonesFlattened: number;
  losersSoftDeleted: number;
};

async function setVoteCountMaintenanceSkipped(commandDb: BoardMergeExecuteDb, skipped: boolean): Promise<void> {
  await commandDb.execute(sql`SELECT set_config('boardsesh.skip_vote_counts', ${skipped ? 'on' : 'off'}, true)`);
}

/**
 * Rebuild `vote_counts` for the given board uuids from the raw `votes` rows.
 * Adapted from `rebuildGymVoteCounts` in dedupe-gym-locations.ts for the
 * 'board' entity type. Loser uuids end up with no votes so their `vote_counts`
 * row is simply deleted (the INSERT re-adds only uuids that still have votes).
 */
async function rebuildBoardVoteCounts(commandDb: BoardMergeExecuteDb, boardUuids: string[]): Promise<void> {
  const boardUuidList = sqlTextList(boardUuids);
  await commandDb.execute(sql`
    DELETE FROM vote_counts
     WHERE entity_type = 'board'::social_entity_type
       AND entity_id IN (${boardUuidList})
  `);

  await commandDb.execute(sql`
    INSERT INTO vote_counts (entity_type, entity_id, upvotes, downvotes, score, hot_score, created_at)
    SELECT
      vote_totals.entity_type,
      vote_totals.entity_id,
      vote_totals.upvotes,
      vote_totals.downvotes,
      vote_totals.score,
      SIGN(vote_totals.score) * LN(GREATEST(ABS(vote_totals.score), 1))
        + EXTRACT(EPOCH FROM COALESCE(feed_created_at.created_at, vote_totals.first_vote_created_at, NOW())) / 45000.0,
      COALESCE(feed_created_at.created_at, vote_totals.first_vote_created_at, NOW())
    FROM (
      SELECT
        votes.entity_type,
        votes.entity_id,
        SUM(CASE WHEN votes.value = 1 THEN 1 ELSE 0 END)::int AS upvotes,
        SUM(CASE WHEN votes.value = -1 THEN 1 ELSE 0 END)::int AS downvotes,
        SUM(votes.value)::int AS score,
        MIN(votes.created_at) AS first_vote_created_at
      FROM votes
      WHERE votes.entity_type = 'board'::social_entity_type
        AND votes.entity_id IN (${boardUuidList})
      GROUP BY votes.entity_type, votes.entity_id
    ) vote_totals
    LEFT JOIN LATERAL (
      SELECT feed_items.created_at
      FROM feed_items
      WHERE feed_items.entity_type = vote_totals.entity_type
        AND feed_items.entity_id = vote_totals.entity_id
      ORDER BY feed_items.created_at ASC, feed_items.id ASC
      LIMIT 1
    ) feed_created_at ON true
    ON CONFLICT (entity_type, entity_id) DO UPDATE SET
      upvotes = excluded.upvotes,
      downvotes = excluded.downvotes,
      score = excluded.score,
      hot_score = excluded.hot_score,
      created_at = excluded.created_at
  `);
}

export async function mergeLockedBoards(
  commandDb: BoardMergeExecuteDb,
  boards: readonly BoardMergeRow[],
  canonicalBoard: BoardMergeRow,
  flattenBoardIds: number[],
): Promise<BoardMergeCounts> {
  const losers = boards.filter((board) => board.uuid !== canonicalBoard.uuid);
  if (losers.length === 0 || !boards.some((board) => board.uuid === canonicalBoard.uuid)) {
    throw new Error('A board merge needs a survivor and at least one distinct duplicate.');
  }
  const loserIds = losers.map((loser) => loser.id);
  const loserUuids = losers.map((loser) => loser.uuid);
  const loserIdList = sqlNumberList(loserIds);
  const allBoardIdList = sqlNumberList([canonicalBoard.id, ...loserIds]);
  const loserUuidList = sqlTextList(loserUuids);
  const allBoardUuidList = sqlTextList([canonicalBoard.uuid, ...loserUuids]);

  // Public survivors may only backfill from public losers. In an all-private
  // cluster the normal donor ranking applies to every loser.
  const metadataDonor = chooseMetadataDonor(losers, canonicalBoard.isPublic);
  // Privacy flags merge monotonically across the ENTIRE cluster. A public
  // canonical row may still have a private duplicate whose owner hid its
  // location or kept it out of discovery. A merge must never weaken either
  // preference.
  const mergedIsUnlisted = boards.some((board) => board.isUnlisted);
  const mergedHidesLocation = boards.some((board) => board.hideLocation);
  // Adopt the donor's name only when the survivor's is a throwaway default and
  // the donor's is a specific (human/gym) name — never clobber a chosen name.
  const shouldAdoptDonorName =
    metadataDonor !== null &&
    isGenericBoardName(canonicalBoard.name, canonicalBoard.boardType) &&
    !isGenericBoardName(metadataDonor.name, canonicalBoard.boardType);
  const survivorName = shouldAdoptDonorName && metadataDonor ? metadataDonor.name : canonicalBoard.name;
  // 1. Metadata backfill on the survivor (never overwrite non-null survivor
  //    fields; adopt the donor's specific name when the survivor's is generic;
  //    preserve the strongest privacy flags from every duplicate).
  const boardsWithMetadataBackfilled = await executeCount(
    commandDb,
    sql`
      WITH updated AS (
        UPDATE user_boards
           SET gym_id = COALESCE(gym_id, ${metadataDonor?.gymId ?? null}),
               latitude = COALESCE(latitude, ${metadataDonor?.latitude ?? null}),
               longitude = COALESCE(longitude, ${metadataDonor?.longitude ?? null}),
               location_name = COALESCE(NULLIF(location_name, ''), ${metadataDonor?.locationName ?? null}),
               hide_location = ${mergedHidesLocation},
               name = ${survivorName},
               is_public = ${canonicalBoard.isPublic},
               is_unlisted = ${mergedIsUnlisted},
               updated_at = NOW()
         WHERE id = ${canonicalBoard.id}
         RETURNING 1
      )
      SELECT count(*)::int AS count FROM updated
    `,
  );

  // 2. board_climb_events — UNIQUE (board_id, seq): move board_id AND seq
  //    together, renumbering losers above both durable history and every
  //    sequence already reserved on a cluster row. The row locks acquired by
  //    refetchClusterForApply serialize this range reservation against the
  //    backend transaction that reserves `presence_seq` and inserts the
  //    matching durable event before releasing the board row.
  const climbEventsMoved = await executeCount(
    commandDb,
    sql`
      WITH survivor_floor AS (
        SELECT GREATEST(
          COALESCE((SELECT max(seq) FROM board_climb_events WHERE board_id = ${canonicalBoard.id}), 0),
          COALESCE((SELECT max(presence_seq) FROM user_boards WHERE id IN (${allBoardIdList})), 0)
        ) AS max_seq
      ),
      renumbered AS (
        SELECT e.id, sf.max_seq + row_number() OVER (ORDER BY e.seq, e.id) AS new_seq
        FROM board_climb_events e
        CROSS JOIN survivor_floor sf
        WHERE e.board_id IN (${loserIdList})
      ),
      moved AS (
        UPDATE board_climb_events e
           SET board_id = ${canonicalBoard.id},
               seq = r.new_seq
          FROM renumbered r
         WHERE e.id = r.id
         RETURNING 1
      )
      SELECT count(*)::int AS count FROM moved
    `,
  );
  const sequenceFloorsAdvanced = await executeCount(
    commandDb,
    sql`
      WITH advanced AS (
        UPDATE user_boards
           SET presence_seq = GREATEST(
                 presence_seq,
                 COALESCE((SELECT max(seq) FROM board_climb_events WHERE board_id = ${canonicalBoard.id}), 0),
                 COALESCE((SELECT max(presence_seq) FROM user_boards WHERE id IN (${allBoardIdList})), 0)
               ),
               updated_at = NOW()
         WHERE id = ${canonicalBoard.id}
         RETURNING 1
      )
      SELECT count(*)::int AS count FROM advanced
    `,
  );

  // 3. board_sessions.board_id — plain repoint (nullable FK, no uniqueness).
  const sessionsMoved = await executeCount(
    commandDb,
    sql`
      WITH moved AS (
        UPDATE board_sessions
           SET board_id = ${canonicalBoard.id}
         WHERE board_id IN (${loserIdList})
         RETURNING 1
      )
      SELECT count(*)::int AS count FROM moved
    `,
  );

  // 4. session_boards — UNIQUE (session_id, board_id): fold loser rows onto the
  //    survivor. ON CONFLICT DO NOTHING keeps the survivor's existing row (and
  //    its created_at); only sessions with no survivor row get a new one, dated
  //    with the earliest loser created_at. Loser rows are then dropped.
  const sessionBoardsInserted = await executeCount(
    commandDb,
    sql`
      WITH inserted AS (
        INSERT INTO session_boards (session_id, board_id, created_at)
        SELECT session_id, ${canonicalBoard.id}, MIN(created_at)
          FROM session_boards
         WHERE board_id IN (${loserIdList})
         GROUP BY session_id
        ON CONFLICT (session_id, board_id) DO NOTHING
        RETURNING 1
      )
      SELECT count(*)::int AS count FROM inserted
    `,
  );
  const sessionBoardsDeleted = await executeCount(
    commandDb,
    sql`
      WITH deleted AS (
        DELETE FROM session_boards
         WHERE board_id IN (${loserIdList})
         RETURNING 1
      )
      SELECT count(*)::int AS count FROM deleted
    `,
  );

  // 5. boardsesh_ticks.board_id — plain repoint (nullable FK, no uniqueness).
  const ticksMoved = await executeCount(
    commandDb,
    sql`
      WITH moved AS (
        UPDATE boardsesh_ticks
           SET board_id = ${canonicalBoard.id}
         WHERE board_id IN (${loserIdList})
         RETURNING 1
      )
      SELECT count(*)::int AS count FROM moved
    `,
  );

  // 6. board_beta_links.board_id — plain repoint (nullable FK to user_boards(id)
  //    ON DELETE SET NULL, no uniqueness on board_id). Losers are soft-deleted,
  //    not hard-deleted, so that FK never fires; repoint explicitly or the beta
  //    links keep pointing at the merged-away loser.
  const betaLinksMoved = await executeCount(
    commandDb,
    sql`
      WITH moved AS (
        UPDATE board_beta_links
           SET board_id = ${canonicalBoard.id}
         WHERE board_id IN (${loserIdList})
         RETURNING 1
      )
      SELECT count(*)::int AS count FROM moved
    `,
  );

  // 7. board_follows — UNIQUE (user_id, board_uuid): fold loser follows onto the
  //    survivor uuid. ON CONFLICT DO NOTHING keeps the survivor's existing
  //    follow row (and its created_at); only follows with no survivor row are
  //    inserted. Loser rows are then dropped.
  const followsInserted = await executeCount(
    commandDb,
    sql`
      WITH inserted AS (
        INSERT INTO board_follows (user_id, board_uuid, created_at)
        SELECT user_id, ${canonicalBoard.uuid}, MIN(created_at)
          FROM board_follows
         WHERE board_uuid IN (${loserUuidList})
         GROUP BY user_id
        ON CONFLICT (user_id, board_uuid) DO NOTHING
        RETURNING 1
      )
      SELECT count(*)::int AS count FROM inserted
    `,
  );
  const followsDeleted = await executeCount(
    commandDb,
    sql`
      WITH deleted AS (
        DELETE FROM board_follows
         WHERE board_uuid IN (${loserUuidList})
         RETURNING 1
      )
      SELECT count(*)::int AS count FROM deleted
    `,
  );

  // 8. Each real loser owner should follow the survivor (skip the system
  //    catalog owner and the survivor's own owner). Reads the loser rows before
  //    they are soft-deleted in step 15.
  const ownerFollowsInserted = await executeCount(
    commandDb,
    sql`
      WITH inserted AS (
        INSERT INTO board_follows (user_id, board_uuid, created_at)
        SELECT DISTINCT owner_id, ${canonicalBoard.uuid}, NOW()
          FROM user_boards
         WHERE id IN (${loserIdList})
           AND owner_id <> ${SYSTEM_USER_ID}
           AND owner_id <> ${canonicalBoard.ownerId}
        ON CONFLICT (user_id, board_uuid) DO NOTHING
        RETURNING 1
      )
      SELECT count(*)::int AS count FROM inserted
    `,
  );

  // 8b. user_board_activity — UNIQUE (user_id, board_uuid): fold each user's
  //    last-used/pin state onto the survivor. Without this a merge silently
  //    unpins the user's pinned board and resets its recency, so it drops to the
  //    bottom of "Your boards" (issue #4884).
  //
  //    MAX(last_used_at) keeps the most recent open across the merged rows.
  //    MIN(pinned_at) keeps the earliest pin, which both preserves pin order and
  //    means "pinned on either row" survives as pinned. ON CONFLICT merges into
  //    the survivor's own row with the same two rules rather than DO NOTHING —
  //    a survivor row that exists but is unpinned must still inherit the
  //    loser's pin.
  const boardActivityInserted = await executeCount(
    commandDb,
    sql`
      WITH inserted AS (
        INSERT INTO user_board_activity (user_id, board_uuid, last_used_at, pinned_at, created_at, updated_at)
        SELECT user_id, ${canonicalBoard.uuid}, MAX(last_used_at), MIN(pinned_at), MIN(created_at), NOW()
          FROM user_board_activity
         WHERE board_uuid IN (${loserUuidList})
         GROUP BY user_id
        ON CONFLICT (user_id, board_uuid) DO UPDATE SET
          last_used_at = GREATEST(user_board_activity.last_used_at, excluded.last_used_at),
          pinned_at = LEAST(user_board_activity.pinned_at, excluded.pinned_at),
          updated_at = NOW()
        RETURNING 1
      )
      SELECT count(*)::int AS count FROM inserted
    `,
  );
  const boardActivityDeleted = await executeCount(
    commandDb,
    sql`
      WITH deleted AS (
        DELETE FROM user_board_activity
         WHERE board_uuid IN (${loserUuidList})
         RETURNING 1
      )
      SELECT count(*)::int AS count FROM deleted
    `,
  );

  // 9. user_board_serials.board_uuid — the actual #3407 fix: converge the sticky
  //    per-user serial pointers onto the survivor. Unique is (user_id,
  //    serial_number), so repointing board_uuid never conflicts.
  const serialPointersRepointed = await executeCount(
    commandDb,
    sql`
      WITH moved AS (
        UPDATE user_board_serials
           SET board_uuid = ${canonicalBoard.uuid},
               updated_at = NOW()
         WHERE board_uuid IN (${loserUuidList})
         RETURNING 1
      )
      SELECT count(*)::int AS count FROM moved
    `,
  );

  // 10. comments.entity_id — plain repoint (no per-entity uniqueness).
  const commentsMoved = await executeCount(
    commandDb,
    sql`
      WITH moved AS (
        UPDATE comments
           SET entity_id = ${canonicalBoard.uuid},
               updated_at = NOW()
         WHERE entity_type = 'board'::social_entity_type
           AND entity_id IN (${loserUuidList})
         RETURNING 1
      )
      SELECT count(*)::int AS count FROM moved
    `,
  );

  // 11. votes — UNIQUE (user_id, entity_type, entity_id): latest-wins upsert of
  //     every vote across survivor+losers onto the survivor uuid, then drop the
  //     loser-uuid rows. Vote-count trigger maintenance is suppressed and the
  //     counts are rebuilt in bulk below.
  await setVoteCountMaintenanceSkipped(commandDb, true);
  const votesUpserted = await executeCount(
    commandDb,
    sql`
      WITH latest_votes AS (
        SELECT DISTINCT ON (user_id)
               user_id,
               value,
               created_at
          FROM votes
         WHERE entity_type = 'board'::social_entity_type
           AND entity_id IN (${allBoardUuidList})
         ORDER BY user_id, created_at DESC, id DESC
      ),
      upserted AS (
        INSERT INTO votes (user_id, entity_type, entity_id, value, created_at)
        SELECT user_id,
               'board'::social_entity_type,
               ${canonicalBoard.uuid},
               value,
               created_at
          FROM latest_votes
        ON CONFLICT (user_id, entity_type, entity_id) DO UPDATE
          SET value = excluded.value,
              created_at = excluded.created_at
        RETURNING 1
      )
      SELECT count(*)::int AS count FROM upserted
    `,
  );
  const votesDeleted = await executeCount(
    commandDb,
    sql`
      WITH deleted AS (
        DELETE FROM votes
         WHERE entity_type = 'board'::social_entity_type
           AND entity_id IN (${loserUuidList})
         RETURNING 1
      )
      SELECT count(*)::int AS count FROM deleted
    `,
  );
  // 12. Rebuild vote_counts for the survivor (and clear the losers').
  await rebuildBoardVoteCounts(commandDb, [canonicalBoard.uuid, ...loserUuids]);
  await setVoteCountMaintenanceSkipped(commandDb, false);

  // 13. feed_items — both the entity pointer and the denormalised board_uuid.
  const feedItemsEntityMoved = await executeCount(
    commandDb,
    sql`
      WITH moved AS (
        UPDATE feed_items
           SET entity_id = ${canonicalBoard.uuid}
         WHERE entity_type = 'board'::social_entity_type
           AND entity_id IN (${loserUuidList})
         RETURNING 1
      )
      SELECT count(*)::int AS count FROM moved
    `,
  );
  const feedItemsBoardUuidMoved = await executeCount(
    commandDb,
    sql`
      WITH moved AS (
        UPDATE feed_items
           SET board_uuid = ${canonicalBoard.uuid}
         WHERE board_uuid IN (${loserUuidList})
         RETURNING 1
      )
      SELECT count(*)::int AS count FROM moved
    `,
  );

  // 14. notifications.entity_id — plain repoint.
  const notificationsMoved = await executeCount(
    commandDb,
    sql`
      WITH moved AS (
        UPDATE notifications
           SET entity_id = ${canonicalBoard.uuid}
         WHERE entity_type = 'board'::social_entity_type
           AND entity_id IN (${loserUuidList})
         RETURNING 1
      )
      SELECT count(*)::int AS count FROM moved
    `,
  );

  // 15. Flatten any existing tombstone chains: boards merged into one of this
  //     cluster's losers by an EARLIER run now point one hop past their target.
  //     Repointing them straight at the new canonical keeps every chain at
  //     depth 1, so the backend's bounded (≤3 hop) chain walk can never hit
  //     its cap no matter how many times boards re-merge.
  let tombstonesFlattened = 0;
  if (flattenBoardIds.length > 0) {
    const flattenBoardIdList = sqlNumberList(flattenBoardIds);
    tombstonesFlattened = await executeCount(
      commandDb,
      sql`
        WITH flattened AS (
          UPDATE user_boards
             SET merged_into_board_uuid = ${canonicalBoard.uuid},
                 updated_at = NOW()
           WHERE id IN (${flattenBoardIdList})
             AND merged_into_board_uuid IN (${loserUuidList})
           RETURNING 1
        )
        SELECT count(*)::int AS count FROM flattened
      `,
    );
  }

  // 16. Soft-delete the losers with the merge tombstone. Serial number is KEPT
  //     (partial indexes exclude deleted rows; retained for forensics + so
  //     stale links can still resolve through merged_into_board_uuid).
  const losersSoftDeleted = await executeCount(
    commandDb,
    sql`
      WITH soft_deleted AS (
        UPDATE user_boards
           SET deleted_at = NOW(),
               is_public = false,
               merged_into_board_uuid = ${canonicalBoard.uuid},
               updated_at = NOW()
         WHERE id IN (${loserIdList})
         RETURNING 1
      )
      SELECT count(*)::int AS count FROM soft_deleted
    `,
  );

  return {
    boardsWithMetadataBackfilled,
    climbEventsMoved,
    sequenceFloorsAdvanced,
    betaLinksMoved,
    sessionsMoved,
    sessionBoardsInserted,
    sessionBoardsDeleted,
    ticksMoved,
    followsInserted,
    followsDeleted,
    ownerFollowsInserted,
    boardActivityInserted,
    boardActivityDeleted,
    serialPointersRepointed,
    commentsMoved,
    votesUpserted,
    votesDeleted,
    feedItemsEntityMoved,
    feedItemsBoardUuidMoved,
    notificationsMoved,
    tombstonesFlattened,
    losersSoftDeleted,
  };
}
