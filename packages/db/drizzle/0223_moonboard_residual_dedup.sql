-- Third MoonBoard dedup pass (#5253): live hold signatures from 0193 with
-- 0163's same-angle MAX/SUM ascent policy. No cached fingerprint or non-NULL
-- climb-angle requirement. User-owned, draft, multi-frame, unlisted and
-- already-redirected rows never contribute to a merge.
--
-- Canonical: most own-angle upstream ascents (max per-angle upstream count
-- when absent), oldest created_at, then UUID. One canonical per layout/holds;
-- every stats angle survives separately. Unknown/different holds are REPORT
-- ONLY: never change holds or infer that an owned UUID proves equivalence.
--
-- Reference collision policies, tick/quality recounts, vote rebuild, cache
-- cleanup and offline tombstones are carried forward from 0193. In particular:
-- votes keep latest; favourites/playlists keep earliest; all-member ranking
-- catches alias-vs-alias collisions in groups with 3+ members. Climb rows,
-- holds and ticks are NEVER deleted. Consolidated stats and relationship
-- collisions are removed only after their surviving representation is chosen.
--
-- Keep sync triggers enabled. Repointed favourites and playlists need explicit
-- tombstones for their old local composite keys; tick UUIDs stay stable.
-- The transaction-start cursor and long-offline-client limitations documented
-- in 0193 still apply. Rehearse runtime on a disposable database; use a quiet
-- deployment window or a sync stability window longer than the measured run.
-- Run this migration BEFORE importing the capture again. Alias snapshots
-- propagate on the catalogue artifact's normal nightly schedule.
--
-- Generated with drizzle-kit generate --custom. The durable guard below is a
-- semantic identity and must NOT change when the migration is renumbered.

CREATE TABLE IF NOT EXISTS _bs_migration_guards (
  tag text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint

DO $$
DECLARE
  v_groups bigint;
  v_skipped_ambiguous bigint;
  v_merged bigint;
  v_recomputed bigint;
  v_tombstones bigint;
  v_tombstone_watermark bigint;
BEGIN
  -- Watermark, not a timestamp: sync_deletions.deleted_at defaults to now(),
  -- which inside a transaction is the transaction's start — already in the
  -- past by the time this line runs, so a clock_timestamp() cutoff would
  -- count zero. The surrogate id is exact and has no such trap.
  SELECT COALESCE(max(id), 0) INTO v_tombstone_watermark FROM sync_deletions;

  IF EXISTS (SELECT 1 FROM _bs_migration_guards WHERE tag = 'moonboard_residual_dedup_5253') THEN
    RAISE NOTICE 'MoonBoard residual dedup already applied — skipping (guard row present)';
    RETURN;
  END IF;

  -- Live per-climb hold signature (board_climbs.hold_fingerprint is sparse —
  -- see header — so compute it directly from board_climb_holds). Deliberately
  -- omits frame_number: MoonBoard climbs are always single-frame
  -- (frames_count = 1, no multi-move routes), so it never distinguishes two
  -- otherwise-identical hold sets here — safe to drop from the signature.
  CREATE TEMP TABLE _mrd_fingerprints ON COMMIT DROP AS
    SELECT climb_uuid,
           string_agg(hold_id::text || ':' || hold_state, ',' ORDER BY hold_id) AS fp
      FROM board_climb_holds
     WHERE board_type = 'moonboard'
     GROUP BY climb_uuid;

  -- Match eligibility in moonboard-reconciliation-report.ts. Old delisted
  -- aliases may still carry pre-0163 stats: including them would count an
  -- already-merged upstream cohort a second time. Only live canonical roots
  -- contribute. A NULL climb angle is valid; stats own the angle dimension.
  CREATE TEMP TABLE _mrd_candidates ON COMMIT DROP AS
    SELECT bc.uuid, bc.angle, bc.layout_id, bc.created_at, bc.name, f.fp,
           a.canonical_uuid AS redirect,
           COALESCE(s.upstream_ascensionist_count, peak.upstream, 0) AS ascents
      FROM board_climbs bc
      JOIN _mrd_fingerprints f ON f.climb_uuid = bc.uuid
      LEFT JOIN board_climb_aliases a
        ON a.board_type = 'moonboard' AND a.alias_uuid = bc.uuid
      LEFT JOIN board_climb_stats s
        ON s.board_type = 'moonboard' AND s.climb_uuid = bc.uuid AND s.angle = bc.angle
      LEFT JOIN LATERAL (
        SELECT max(upstream_ascensionist_count) AS upstream
          FROM board_climb_stats ps
         WHERE ps.board_type = 'moonboard' AND ps.climb_uuid = bc.uuid
      ) peak ON true
     WHERE bc.board_type = 'moonboard'
       AND bc.user_id IS NULL
       AND bc.is_draft = false
       AND bc.is_listed = true
       AND bc.frames_count = 1;

  CREATE TEMP TABLE _mrd_members ON COMMIT DROP AS
    SELECT * FROM _mrd_candidates WHERE redirect IS NULL OR redirect = uuid;

  -- A listed redirect leaving the signature group is evidence of an identity
  -- conflict. Refuse the whole group, including cycles and chains whose next
  -- hop is not a live root with these holds. The report names these conflicts.
  CREATE TEMP TABLE _mrd_raw_groups ON COMMIT DROP AS
    SELECT layout_id, fp, count(*) AS member_count
      FROM _mrd_members GROUP BY layout_id, fp HAVING count(*) > 1;

  CREATE TEMP TABLE _mrd_groups ON COMMIT DROP AS
    SELECT g.layout_id, g.fp FROM _mrd_raw_groups g
     WHERE NOT EXISTS (
       SELECT 1 FROM _mrd_candidates redirect
        WHERE redirect.layout_id = g.layout_id AND redirect.fp = g.fp
          AND redirect.redirect IS NOT NULL AND redirect.redirect <> redirect.uuid
          AND NOT EXISTS (
            SELECT 1 FROM _mrd_members target
             WHERE target.uuid = redirect.redirect
               AND target.layout_id = g.layout_id AND target.fp = g.fp
          )
     );

  SELECT count(*) INTO v_groups FROM _mrd_groups;
  SELECT count(*) - v_groups INTO v_skipped_ambiguous FROM _mrd_raw_groups;

  CREATE TEMP TABLE _mrd_canon ON COMMIT DROP AS
    SELECT DISTINCT ON (m.layout_id, m.fp) m.layout_id, m.fp, m.uuid AS canonical_uuid
      FROM _mrd_members m
      JOIN _mrd_groups g ON g.layout_id = m.layout_id AND g.fp = m.fp
     ORDER BY m.layout_id, m.fp, m.ascents DESC, m.created_at ASC NULLS LAST, m.uuid ASC;

  -- Non-canonical member -> canonical uuid, carrying its own angle (needed by
  -- every angle-preserving repoint step below).
  CREATE TEMP TABLE _mrd_map ON COMMIT DROP AS
    SELECT m.uuid AS alias_uuid, m.angle, c.canonical_uuid
      FROM _mrd_members m
      JOIN _mrd_canon c ON c.layout_id = m.layout_id AND c.fp = m.fp
     WHERE m.uuid <> c.canonical_uuid;

  SELECT count(*) INTO v_merged FROM _mrd_map;

  -- All (canonical_uuid, member_uuid) pairs INCLUDING the self-pair. This is
  -- the collision-ranking input for steps 4/5: ranking has to see the
  -- canonical's own row alongside every alias's, or two aliases that collide
  -- only with each other slip through. Also used to find every vote_counts
  -- row feeding the hot_score rebuild in step 6.
  CREATE TEMP TABLE _mrd_all_ids ON COMMIT DROP AS
    SELECT canonical_uuid, alias_uuid AS uuid FROM _mrd_map
    UNION
    SELECT DISTINCT canonical_uuid, canonical_uuid FROM _mrd_map;

  -- 1. Alias every non-canonical row onto the canonical. Repoint any
  --    pre-existing alias that (unexpectedly) already pointed at an
  --    alias_uuid first, defensively, then upsert the direct alias.
  --    This UPDATE fixes EVERY row whose canonical_uuid currently equals ANY
  --    alias_uuid being retired in this batch (_mrd_map), regardless of how
  --    many logical hops that row represents in some pre-existing chain — so
  --    this migration never WORSENS chain depth for anything it touches.
  --    KNOWN LIMITATION (pre-existing, not introduced here, same as 0163):
  --    packages/db/src/queries/aliases.ts's resolveCanonicalClimbUuid (the
  --    general app-wide resolver used by ticks/climb lookups) does a SINGLE
  --    lookup, not a full chain walk. If some OTHER, unrelated process ever
  --    created a chain deeper than one hop (Y -> X -> Z, where X is not
  --    itself retired by this migration), that resolver already returned the
  --    intermediate node X for Y before this migration ran, and still will
  --    after — orthogonal to what this migration does. No evidence this shape exists in
  --    prod; flattening it would be a separate, general alias-integrity fix.
  UPDATE board_climb_aliases a
     SET canonical_uuid = m.canonical_uuid, last_seen_at = now()
    FROM _mrd_map m
   WHERE a.board_type = 'moonboard' AND a.canonical_uuid = m.alias_uuid;

  INSERT INTO board_climb_aliases (board_type, alias_uuid, canonical_uuid, source)
  SELECT 'moonboard', alias_uuid, canonical_uuid, 'moonboard-residual-dedup' FROM _mrd_map
  ON CONFLICT (board_type, alias_uuid) DO UPDATE
    SET canonical_uuid = excluded.canonical_uuid, last_seen_at = now();

  -- 2. Fold ALL members, including the canonical, before writing once per
  -- (canonical, stats angle). 0163's policy is deliberate: identical names
  -- AND identical counts mean a double import (MAX); every other cohort is
  -- summed. NULL counts mean zero, as in 0163. Unknown names do not prove a
  -- double import. Never combine counts across angles.
  -- Non-count fields keep the canonical's first non-null value, otherwise
  -- prefer a member graded at this angle, most upstream ascents, then UUID.
  CREATE TEMP TABLE _mrd_stats_src ON COMMIT DROP AS
    SELECT canonical_uuid, angle,
           (array_agg(display_difficulty ORDER BY rank) FILTER (WHERE display_difficulty IS NOT NULL))[1] AS display_difficulty,
           (array_agg(benchmark_difficulty ORDER BY rank) FILTER (WHERE benchmark_difficulty IS NOT NULL))[1] AS benchmark_difficulty,
           CASE WHEN count(DISTINCT lower(name)) = 1 AND count(name) = count(*)
                     AND min(COALESCE(upstream_ascensionist_count, 0)) = max(COALESCE(upstream_ascensionist_count, 0))
                THEN max(COALESCE(upstream_ascensionist_count, 0))
                ELSE sum(COALESCE(upstream_ascensionist_count, 0)) END AS upstream_ascensionist_count,
           0::bigint AS boardsesh_ascensionist_count,
           (array_agg(difficulty_average ORDER BY rank) FILTER (WHERE difficulty_average IS NOT NULL))[1] AS difficulty_average,
           (array_agg(upstream_quality_average ORDER BY rank) FILTER (WHERE upstream_quality_average IS NOT NULL))[1] AS quality_average,
           (array_agg(upstream_quality_average ORDER BY rank) FILTER (WHERE upstream_quality_average IS NOT NULL))[1] AS upstream_quality_average,
           NULL::double precision AS boardsesh_quality_sum,
           NULL::bigint AS boardsesh_quality_count,
           bool_or(quality_normalized) AS quality_normalized,
           (array_agg(fa_username ORDER BY rank) FILTER (WHERE fa_username IS NOT NULL))[1] AS fa_username,
           (array_agg(fa_at ORDER BY rank) FILTER (WHERE fa_at IS NOT NULL))[1] AS fa_at,
           max(upstream_synced_at) AS upstream_synced_at
      FROM (
        SELECT ids.canonical_uuid, members.name, s.*,
               ROW_NUMBER() OVER (
                 PARTITION BY ids.canonical_uuid, s.angle
                 ORDER BY (s.climb_uuid = ids.canonical_uuid) DESC,
                          (s.angle = members.angle) DESC NULLS LAST,
                          COALESCE(s.upstream_ascensionist_count, 0) DESC,
                          s.climb_uuid ASC
               ) AS rank
          FROM board_climb_stats s
          JOIN _mrd_all_ids ids ON ids.uuid = s.climb_uuid
          JOIN _mrd_members members ON members.uuid = s.climb_uuid
         WHERE s.board_type = 'moonboard'
      ) ranked
     GROUP BY canonical_uuid, angle;

  -- Step 3b recounts the Boardsesh half for EVERY written key, including
  -- tickless keys, rather than adding or copying stale materialized counts.
  CREATE TEMP TABLE _mrd_written_stats_keys ON COMMIT DROP AS
  WITH written AS (
    INSERT INTO board_climb_stats (board_type, climb_uuid, angle, display_difficulty, benchmark_difficulty,
           ascensionist_count, upstream_ascensionist_count, boardsesh_ascensionist_count, difficulty_average,
           quality_average, upstream_quality_average, boardsesh_quality_sum, boardsesh_quality_count,
           quality_normalized, fa_username, fa_at, upstream_synced_at)
    SELECT 'moonboard', src.canonical_uuid, src.angle, src.display_difficulty, src.benchmark_difficulty,
           COALESCE(src.upstream_ascensionist_count, 0) + COALESCE(src.boardsesh_ascensionist_count, 0),
           src.upstream_ascensionist_count, src.boardsesh_ascensionist_count, src.difficulty_average,
           src.quality_average, src.upstream_quality_average, src.boardsesh_quality_sum,
           src.boardsesh_quality_count, src.quality_normalized, src.fa_username, src.fa_at,
           src.upstream_synced_at
      FROM _mrd_stats_src src
    ON CONFLICT (board_type, climb_uuid, angle) DO UPDATE SET
      display_difficulty = COALESCE(board_climb_stats.display_difficulty, excluded.display_difficulty),
      benchmark_difficulty = COALESCE(board_climb_stats.benchmark_difficulty, excluded.benchmark_difficulty),
      upstream_ascensionist_count = excluded.upstream_ascensionist_count,
      ascensionist_count =
        excluded.upstream_ascensionist_count
        + COALESCE(board_climb_stats.boardsesh_ascensionist_count, 0),
      difficulty_average = COALESCE(board_climb_stats.difficulty_average, excluded.difficulty_average),
      upstream_quality_average = COALESCE(board_climb_stats.upstream_quality_average, excluded.upstream_quality_average),
      fa_username = COALESCE(board_climb_stats.fa_username, excluded.fa_username),
      fa_at = COALESCE(board_climb_stats.fa_at, excluded.fa_at),
      quality_normalized = board_climb_stats.quality_normalized OR excluded.quality_normalized,
      upstream_synced_at = GREATEST(board_climb_stats.upstream_synced_at, excluded.upstream_synced_at)
    RETURNING board_climb_stats.climb_uuid, board_climb_stats.angle
  )
  SELECT DISTINCT climb_uuid, angle FROM written;

  -- The rows just copied onto the canonical uuid now fully duplicate the
  -- retiring uuid's own stats rows (same board_type/angle, identical values) —
  -- drop the originals so nothing that scans board_climb_stats broadly (a
  -- leaderboard, a bulk recompute) double-counts a delisted climb's ascents.
  -- Safe: every value has already been copied forward by the INSERT above.
  DELETE FROM board_climb_stats s USING _mrd_map m
   WHERE s.board_type = 'moonboard' AND s.climb_uuid = m.alias_uuid;

  -- 3. Plain repoints — climb_uuid moves to canonical, each row's own
  --    angle/value is untouched, no uniqueness collision is possible.
  --
  --    Ticks are captured as they move: step 3b below has to recompute the
  --    Boardsesh half of board_climb_stats for every key that now owns a
  --    repointed tick, and after the UPDATE there is no way to tell a
  --    just-moved tick from one that was always on the canonical.
  --    Offline propagation: trg_boardsesh_ticks_set_updated_at (0146) stamps
  --    updated_at on any change outside its excluded column set (climb_uuid is
  --    NOT excluded), so the cursor moves and syncTicks re-ships the row. No
  --    sync_deletions tombstone is needed here: the mobile local primary key
  --    for boardsesh_ticks is `uuid` (packages/shared/offline-sync/src/sync/
  --    table-config.ts), which this repoint does not touch, so the client
  --    updates the row in place rather than stranding one at an old key.
  CREATE TEMP TABLE _mrd_repointed_tick_keys ON COMMIT DROP AS
  WITH moved AS (
    UPDATE boardsesh_ticks t SET climb_uuid = m.canonical_uuid
      FROM _mrd_map m WHERE t.board_type = 'moonboard' AND t.climb_uuid = m.alias_uuid
    RETURNING t.climb_uuid, t.angle
  )
  SELECT DISTINCT climb_uuid, angle FROM moved;

  UPDATE board_climb_stats_history h SET climb_uuid = m.canonical_uuid
    FROM _mrd_map m WHERE h.board_type = 'moonboard' AND h.climb_uuid = m.alias_uuid;

  UPDATE board_climb_events e SET climb_uuid = m.canonical_uuid
    FROM _mrd_map m WHERE e.board_type = 'moonboard' AND e.climb_uuid = m.alias_uuid;

  UPDATE climb_proposals p SET climb_uuid = m.canonical_uuid
    FROM _mrd_map m WHERE p.board_type = 'moonboard' AND p.climb_uuid = m.alias_uuid;

  UPDATE comments c SET entity_id = m.canonical_uuid
    FROM _mrd_map m WHERE c.entity_type = 'climb' AND c.entity_id = m.alias_uuid;

  UPDATE feed_items f SET entity_id = m.canonical_uuid
    FROM _mrd_map m WHERE f.entity_type = 'climb' AND f.entity_id = m.alias_uuid;

  UPDATE notifications n SET entity_id = m.canonical_uuid
    FROM _mrd_map m WHERE n.entity_type = 'climb' AND n.entity_id = m.alias_uuid;

  -- 3b. Recompute the BOARDSESH half of board_climb_stats for every key this
  --     migration touched. Step 2's row-level merge cannot get this right on
  --     its own: boardsesh_ascensionist_count is a count of DISTINCT climbers,
  --     so a climber who ticked BOTH aliases at the same angle is ONE
  --     ascensionist after the merge — SUM would double-count them, GREATEST
  --     would lose a second climber who only ticked the other alias. The only
  --     correct answer is to recount from the ticks, which step 3 has just
  --     finished repointing onto the canonical.
  --
  --     Ported faithfully from recomputeClimbStatsBulk() in
  --     packages/db/src/queries/climb-stats/recompute.ts (the same code the
  --     backend runs after every tick write, via
  --     packages/backend/src/graphql/resolvers/ticks/recompute-climb-stats.ts),
  --     keeping every predicate: only origin='native' flash/send ticks count;
  --     a climber with ANY non-native flash/send at the key is excluded
  --     entirely (their ascent is already inside upstream_ascensionist_count);
  --     kilter_detached_at IS NULL is applied BEFORE the per-user grouping;
  --     a native tick pushed to Kilter more than 48h before the last upstream
  --     sync is treated as absorbed into the upstream count.
  --     quality_sum/quality_count take each climber's LATEST rated native
  --     flash/send tick (max climbed_at, tie-break max id, quality 1..5), and
  --     quality_average is re-blended with the recipe whose single source of
  --     truth is blendedQualityAverageSql in
  --     packages/db/src/queries/climb-stats/quality-blend.ts.
  --     recompute.ts's boardsesh_owned branch is deliberately NOT ported: it
  --     applies to board_climbs.user_id IS NOT NULL, and _mrd_members fences
  --     this migration to user_id IS NULL catalog rows, so every canonical
  --     here is non-owned by construction.
  --
  --     Keys: every (canonical, angle) key step 2 actually wrote — captured by
  --     RETURNING into _mrd_written_stats_keys, INSERT and ON CONFLICT alike —
  --     plus every key that now owns a repointed tick.
  --
  --     The step-2 keys are deliberately NOT gated on tick presence. Step 2
  --     rewrote those rows' upstream half, so their Boardsesh half and blend
  --     have to be re-derived whether or not a tick survives at that key: a key
  --     with zero live ticks recomputes to boardsesh 0 / NULL and an
  --     upstream-only blend, which is the CORRECT repair, not a disturbance.
  --     Prod carries stats rows whose Boardsesh half outlived its ticks —
  --     deleteAccount cascades boardsesh_ticks (packages/db/src/schema/app/
  --     ascents.ts, onDelete: 'cascade') with no recompute anywhere on that
  --     path, and selfHealStaleClimbStats joins THROUGH a surviving tick
  --     (packages/db/src/queries/climb-stats/self-heal.ts) so it can never see
  --     them. An earlier version of this migration imported exactly those stale
  --     halves onto the canonical and then skipped the key, publishing a
  --     phantom ascent count on the surviving climb permanently.
  --
  --     The repointed-tick keys DO keep the tick-presence gate. This migration
  --     rewrote no column on those rows — it only moved a tick onto them — so a
  --     key whose only arrivals are detached ticks has nothing to re-derive,
  --     and re-blending it would rewrite quality_average from the upstream
  --     terms on a row this migration has no business touching.
  --
  --     Rows only, too: this pass never INSERTs a stats row, so a key with no
  --     stats row before the merge still has none after (recompute, not invent)
  --     and the next tick write seeds it the normal way. Offline propagation is
  --     the trigger's job as usual (trg_board_climb_stats_set_sync_fields,
  --     0144/0146) — do NOT stamp updated_at/sync_seq by hand.
  CREATE TEMP TABLE _mrd_recompute_keys ON COMMIT DROP AS
    SELECT climb_uuid, angle FROM _mrd_written_stats_keys
    UNION
    SELECT k.climb_uuid, k.angle
      FROM _mrd_repointed_tick_keys k
     WHERE EXISTS (
       SELECT 1 FROM boardsesh_ticks bt
        WHERE bt.board_type = 'moonboard'
          AND bt.climb_uuid = k.climb_uuid
          AND bt.angle = k.angle
          AND bt.kilter_detached_at IS NULL
     );

  WITH per_user AS (
    SELECT bt.climb_uuid, bt.angle, bt.user_id,
           bool_or(
             bt.origin = 'native' AND bt.status IN ('flash','send')
             AND NOT (
               bt.kilter_id IS NOT NULL
               AND bt.kilter_synced_at IS NOT NULL
               AND s.upstream_synced_at IS NOT NULL
               AND bt.kilter_synced_at < s.upstream_synced_at - interval '48 hours'
             )
           ) AS has_unabsorbed_native_send,
           bool_or(bt.origin <> 'native' AND bt.status IN ('flash','send')) AS has_upstream
      FROM boardsesh_ticks bt
      JOIN _mrd_recompute_keys k ON k.climb_uuid = bt.climb_uuid AND k.angle = bt.angle
      JOIN board_climb_stats s
        ON s.board_type = 'moonboard' AND s.climb_uuid = bt.climb_uuid AND s.angle = bt.angle
     WHERE bt.board_type = 'moonboard'
       AND bt.kilter_detached_at IS NULL
     GROUP BY bt.climb_uuid, bt.angle, bt.user_id
  ),
  counts AS (
    SELECT climb_uuid, angle,
           COUNT(*) FILTER (WHERE has_unabsorbed_native_send AND NOT has_upstream) AS distinct_senders
      FROM per_user
     GROUP BY climb_uuid, angle
  ),
  bs_quality AS (
    SELECT latest.climb_uuid, latest.angle,
           SUM(latest.quality)::double precision AS bs_quality_sum,
           COUNT(*)::bigint AS bs_quality_count
      FROM (
        SELECT DISTINCT ON (bt.climb_uuid, bt.angle, bt.user_id)
               bt.climb_uuid, bt.angle, bt.quality
          FROM boardsesh_ticks bt
          JOIN _mrd_recompute_keys k ON k.climb_uuid = bt.climb_uuid AND k.angle = bt.angle
         WHERE bt.board_type = 'moonboard'
           AND bt.origin = 'native'
           AND bt.status IN ('flash','send')
           AND bt.quality IS NOT NULL
           AND bt.quality >= 1
           AND bt.quality <= 5
           AND bt.kilter_detached_at IS NULL
         ORDER BY bt.climb_uuid, bt.angle, bt.user_id, bt.climbed_at DESC, bt.id DESC
      ) latest
     GROUP BY latest.climb_uuid, latest.angle
  )
  UPDATE board_climb_stats s
     SET boardsesh_ascensionist_count = COALESCE(c.distinct_senders, 0),
         -- The materialized invariant, rewritten in the same statement that
         -- moves its Boardsesh term (see boardClimbStats in
         -- packages/db/src/schema/boards/unified.ts).
         ascensionist_count = COALESCE(s.upstream_ascensionist_count, 0) + COALESCE(c.distinct_senders, 0),
         boardsesh_quality_sum = bq.bs_quality_sum,
         boardsesh_quality_count = NULLIF(bq.bs_quality_count, 0),
         -- blendedQualityAverageSql (quality-blend.ts) inlined verbatim. The
         -- Boardsesh terms MUST come from the CTE, not from the columns being
         -- SET above: an UPDATE's SET expressions still see the OLD values.
         quality_average = COALESCE(
           (
             (COALESCE(s.upstream_quality_average * s.upstream_ascensionist_count, 0) + COALESCE(bq.bs_quality_sum, 0))
             / NULLIF(
                 COALESCE(CASE WHEN s.upstream_quality_average IS NOT NULL THEN s.upstream_ascensionist_count END, 0)
                 + COALESCE(bq.bs_quality_count, 0),
                 0
               )
           ),
           s.upstream_quality_average
         )
    FROM _mrd_recompute_keys k
    LEFT JOIN counts c ON c.climb_uuid = k.climb_uuid AND c.angle = k.angle
    LEFT JOIN bs_quality bq ON bq.climb_uuid = k.climb_uuid AND bq.angle = k.angle
   WHERE s.board_type = 'moonboard' AND s.climb_uuid = k.climb_uuid AND s.angle = k.angle;

  -- 4. Repoints where a real collision is possible because the post-repoint
  --    unique key can already be taken. Every one of these ranks ALL rows
  --    touching the group — the canonical's own pre-existing row (if any)
  --    PLUS every alias member's row, via _mrd_all_ids — per post-repoint key
  --    and keeps exactly one. It is NOT just "does it collide with the
  --    canonical": two DIFFERENT non-canonical members can collide with EACH
  --    OTHER once both repoint onto the same canonical, which a
  --    canonical-only check misses entirely (reproduced against a scratch DB
  --    with a 3-member group: two losing members both playlisted, migration
  --    aborted with a unique-constraint violation).
  --
  --    SURVIVOR POLICY. Which row survives is a product decision, not an
  --    implementation detail — a user opens the app after this migration and
  --    sees whichever row we kept. Each table below states its policy on its
  --    own ORDER BY so a single table can be re-argued without touching the
  --    others:
  --      votes                  -> the user's LATEST vote (their current opinion)
  --      user_favorites         -> the EARLIEST row ("when I first added it")
  --      playlist_climbs        -> the EARLIEST row (same reasoning + its slot)
  --      board_circuits_climbs  -> the EARLIEST row (lowest position)
  --      climb_classic_status   -> canonical's own, else the strongest signal
  --      climb_community_status -> canonical's own, else the strongest signal
  --      board_beta_links       -> canonical's own, else the strongest signal
  --      board_climb_ratings    -> canonical's own, else lowest id (no MoonBoard
  --                                row can exist — see 5b)
  --    Every ORDER BY ends in a unique column (id / ctid) so the outcome is
  --    deterministic on ties, not left to physical row order.
  --
  --    OFFLINE CLIENTS. user_favorites and playlist_climbs are the only two
  --    tables here that offline clients hold (packages/shared/offline-sync/
  --    src/sync/table-config.ts), and both are keyed LOCALLY by climb_uuid —
  --    user_favorites by (board_name, climb_uuid, angle), playlist_climbs by
  --    (playlist_uuid, climb_uuid). A repoint therefore MOVES a row's client
  --    primary key, and an UPDATE fires no delete trigger, so without help the
  --    device keeps the old-key row forever alongside the new one. Two things
  --    handle that below: the DELETEs emit tombstones through the live
  --    triggers (trg_favorites_delete / trg_playlist_climbs_delete, 0144/0146
  --    — this migration must NOT set boardsesh.suppress_sync_tombstones), and
  --    the surviving-but-moved rows get a hand-written sync_deletions row for
  --    the key they vacated. For those two tables the survivor is additionally
  --    pinned to the canonical's OWN physical row whenever one exists, with
  --    the policy winner's values copied onto it: that keeps every tombstone
  --    naming a key nothing re-occupies, so a tombstone can never race ahead
  --    of the upsert that would restore the row (pull-client applies deletions
  --    before table pulls, but the two ride independent cursors).
  --    board_circuits_climbs, climb_classic_status, climb_community_status,
  --    board_beta_links, votes, vote_counts and board_climb_ratings are not in
  --    any sync table config and have no delete trigger, so they need neither.

  -- playlist_climbs. Policy: EARLIEST added_at wins, and the surviving row
  -- keeps the earliest position so the climb holds its slot in the list.
  CREATE TEMP TABLE _mrd_playlist_plan ON COMMIT DROP AS
    SELECT pc.id, pc.playlist_id, pc.climb_uuid AS old_climb_uuid, ids.canonical_uuid,
           MIN(pc.added_at) OVER w AS winner_added_at,
           MIN(pc.position) OVER w AS winner_position,
           ROW_NUMBER() OVER (
             PARTITION BY pc.playlist_id, ids.canonical_uuid
             ORDER BY (pc.climb_uuid = ids.canonical_uuid) DESC,
                      pc.added_at ASC, pc.position ASC, pc.id ASC
           ) AS keep_rank
      FROM playlist_climbs pc
      JOIN _mrd_all_ids ids ON ids.uuid = pc.climb_uuid
    WINDOW w AS (PARTITION BY pc.playlist_id, ids.canonical_uuid);

  DELETE FROM playlist_climbs pc USING _mrd_playlist_plan p
   WHERE pc.id = p.id AND p.keep_rank > 1;

  -- Tombstone the key each surviving-but-moved row vacates. Mirrors
  -- log_deletion_playlist_climbs() (0146) exactly: record_id is
  -- '<playlist uuid>:<climb uuid>' — the playlist's UUID, not its id — scoped
  -- to the playlist OWNER, and both of the trigger's guards (playlist gone /
  -- no owner row) are reproduced as inner joins so a hand-written tombstone
  -- can never be broader than the trigger's own.
  INSERT INTO sync_deletions (table_name, record_id, user_id)
  SELECT 'playlist_climbs', pl.uuid || ':' || p.old_climb_uuid, po.user_id
    FROM _mrd_playlist_plan p
    JOIN playlists pl ON pl.id = p.playlist_id
    JOIN LATERAL (
      SELECT o.user_id FROM playlist_ownership o
       WHERE o.playlist_id = p.playlist_id AND o.role = 'owner'
       LIMIT 1
    ) po ON true
   WHERE p.keep_rank = 1 AND p.old_climb_uuid <> p.canonical_uuid;

  UPDATE playlist_climbs pc
     SET climb_uuid = p.canonical_uuid,
         added_at = p.winner_added_at,
         position = p.winner_position
    FROM _mrd_playlist_plan p
   WHERE pc.id = p.id AND p.keep_rank = 1
     AND (pc.climb_uuid IS DISTINCT FROM p.canonical_uuid
          OR pc.added_at IS DISTINCT FROM p.winner_added_at
          OR pc.position IS DISTINCT FROM p.winner_position);

  -- board_circuits_climbs. Policy: EARLIEST row = lowest position (the table
  -- has no timestamp at all). A collision can leave a gap in the circuit's
  -- position sequence — accepted: position only drives ORDER BY for circuit
  -- member display, which doesn't need contiguity. No surrogate id on this
  -- table; ctid is a safe same-statement tiebreak.
  WITH ranked AS (
    SELECT cc.ctid,
           ROW_NUMBER() OVER (
             PARTITION BY cc.circuit_uuid, ids.canonical_uuid
             ORDER BY cc.position ASC NULLS LAST, cc.ctid ASC
           ) AS keep_rank
      FROM board_circuits_climbs cc
      JOIN _mrd_all_ids ids ON ids.uuid = cc.climb_uuid
     WHERE cc.board_type = 'moonboard'
  )
  DELETE FROM board_circuits_climbs cc USING ranked r
   WHERE cc.ctid = r.ctid AND r.keep_rank > 1;
  UPDATE board_circuits_climbs cc SET climb_uuid = m.canonical_uuid
    FROM _mrd_map m WHERE cc.board_type = 'moonboard' AND cc.climb_uuid = m.alias_uuid;

  -- climb_classic_status. Policy: the canonical's own row wins; failing that,
  -- the strongest signal — a row that says the climb IS classic beats one that
  -- says it isn't (the table carries no ascent/confirmation count), then the
  -- earliest row by id.
  WITH ranked AS (
    SELECT cs.id,
           ROW_NUMBER() OVER (
             PARTITION BY ids.canonical_uuid
             ORDER BY (cs.climb_uuid = ids.canonical_uuid) DESC, cs.is_classic DESC, cs.id ASC
           ) AS keep_rank
      FROM climb_classic_status cs
      JOIN _mrd_all_ids ids ON ids.uuid = cs.climb_uuid
     WHERE cs.board_type = 'moonboard'
  )
  DELETE FROM climb_classic_status cs USING ranked r
   WHERE cs.id = r.id AND r.keep_rank > 1;
  UPDATE climb_classic_status cs SET climb_uuid = m.canonical_uuid
    FROM _mrd_map m WHERE cs.board_type = 'moonboard' AND cs.climb_uuid = m.alias_uuid;

  -- board_beta_links. Policy: the canonical's own row wins; failing that, the
  -- strongest signal — a beta video already tied to a specific ascent
  -- (tick_uuid IS NOT NULL) beats a loose one, then the earliest created_at
  -- (stored as text; ASC is still chronological for ISO-8601), then ctid. No
  -- surrogate id on this table either.
  WITH ranked AS (
    SELECT bl.ctid,
           ROW_NUMBER() OVER (
             PARTITION BY bl.link, ids.canonical_uuid
             ORDER BY (bl.climb_uuid = ids.canonical_uuid) DESC,
                      (bl.tick_uuid IS NOT NULL) DESC,
                      bl.created_at ASC NULLS LAST,
                      bl.ctid ASC
           ) AS keep_rank
      FROM board_beta_links bl
      JOIN _mrd_all_ids ids ON ids.uuid = bl.climb_uuid
     WHERE bl.board_type = 'moonboard'
  )
  DELETE FROM board_beta_links bl USING ranked r
   WHERE bl.ctid = r.ctid AND r.keep_rank > 1;
  UPDATE board_beta_links bl SET climb_uuid = m.canonical_uuid
    FROM _mrd_map m WHERE bl.board_type = 'moonboard' AND bl.climb_uuid = m.alias_uuid;

  -- 5. Angle-scoped uniqueness tables — same all-members ranking as step 4,
  --    partitioned additionally by each row's OWN angle (not the group
  --    member's "native" angle): _mrd_groups guarantees distinct angles
  --    across DIFFERENT members, so a same-angle collision here would only
  --    come from a row at a non-native angle, but nothing enforces that
  --    can't happen, and the ranking handles it for free either way.

  -- user_favorites. Policy: EARLIEST created_at wins — a favourite records
  -- when the climber first starred the problem, and merging two angle-rows
  -- must not reset that. The surviving row is the canonical's own whenever it
  -- has one (see the offline-clients note in step 4), with the earliest
  -- created_at copied onto it.
  CREATE TEMP TABLE _mrd_fav_plan ON COMMIT DROP AS
    SELECT uf.id, uf.user_id, uf.angle, uf.climb_uuid AS old_climb_uuid, ids.canonical_uuid,
           MIN(uf.created_at) OVER (PARTITION BY uf.user_id, ids.canonical_uuid, uf.angle) AS winner_created_at,
           ROW_NUMBER() OVER (
             PARTITION BY uf.user_id, ids.canonical_uuid, uf.angle
             ORDER BY (uf.climb_uuid = ids.canonical_uuid) DESC, uf.created_at ASC, uf.id ASC
           ) AS keep_rank
      FROM user_favorites uf
      JOIN _mrd_all_ids ids ON ids.uuid = uf.climb_uuid
     WHERE uf.board_name = 'moonboard';

  DELETE FROM user_favorites uf USING _mrd_fav_plan p
   WHERE uf.id = p.id AND p.keep_rank > 1;

  -- Tombstone the key each surviving-but-moved row vacates, in
  -- log_deletion_favorites()'s exact format (0144):
  -- '<board_name>:<climb uuid>:<angle>', scoped to the owning user.
  INSERT INTO sync_deletions (table_name, record_id, user_id)
  SELECT 'user_favorites', 'moonboard:' || p.old_climb_uuid || ':' || p.angle::text, p.user_id
    FROM _mrd_fav_plan p
   WHERE p.keep_rank = 1 AND p.old_climb_uuid <> p.canonical_uuid;

  UPDATE user_favorites uf
     SET climb_uuid = p.canonical_uuid,
         created_at = p.winner_created_at
    FROM _mrd_fav_plan p
   WHERE uf.id = p.id AND p.keep_rank = 1
     AND (uf.climb_uuid IS DISTINCT FROM p.canonical_uuid
          OR uf.created_at IS DISTINCT FROM p.winner_created_at);

  -- climb_community_status. Policy: the canonical's own row wins; failing
  -- that, the strongest signal — the most recent community decision
  -- (highest last_proposal_id, then newest updated_at), then id.
  WITH ranked AS (
    SELECT ccs.id,
           ROW_NUMBER() OVER (
             PARTITION BY ids.canonical_uuid, ccs.angle
             ORDER BY (ccs.climb_uuid = ids.canonical_uuid) DESC,
                      ccs.last_proposal_id DESC NULLS LAST,
                      ccs.updated_at DESC,
                      ccs.id ASC
           ) AS keep_rank
      FROM climb_community_status ccs
      JOIN _mrd_all_ids ids ON ids.uuid = ccs.climb_uuid
     WHERE ccs.board_type = 'moonboard'
  )
  DELETE FROM climb_community_status ccs USING ranked r
   WHERE ccs.id = r.id AND r.keep_rank > 1;
  UPDATE climb_community_status ccs SET climb_uuid = m.canonical_uuid
    FROM _mrd_map m WHERE ccs.board_type = 'moonboard' AND ccs.climb_uuid = m.alias_uuid;

  -- 5b. board_climb_ratings — see header: no MoonBoard row can exist today
  -- (only writer hardcodes boardType to Kilter), so this is a defensive no-op
  -- kept in case that ever changes, and its survivor policy is left at
  -- "canonical's own, else lowest id" rather than invented for dead code.
  -- Same all-members ranking, unique key (board_type, climb_uuid, angle, user_id).
  WITH ranked AS (
    SELECT bcr.id,
           ROW_NUMBER() OVER (
             PARTITION BY bcr.user_id, ids.canonical_uuid, bcr.angle
             ORDER BY (bcr.climb_uuid = ids.canonical_uuid) DESC, bcr.id ASC
           ) AS keep_rank
      FROM board_climb_ratings bcr
      JOIN _mrd_all_ids ids ON ids.uuid = bcr.climb_uuid
     WHERE bcr.board_type = 'moonboard'
  )
  DELETE FROM board_climb_ratings bcr USING ranked r
   WHERE bcr.id = r.id AND r.keep_rank > 1;
  UPDATE board_climb_ratings bcr SET climb_uuid = m.canonical_uuid
    FROM _mrd_map m WHERE bcr.board_type = 'moonboard' AND bcr.climb_uuid = m.alias_uuid;

  -- 5c. board_climb_grades — like 5b, a defensive no-op. MoonBoard is outside
  -- CROWD_MEAN_BOARDS (packages/db/src/queries/grade-model/constants.ts), the
  -- only board list refresh-climb-grades.ts iterates, so no MoonBoard row can
  -- exist today. It is repointed anyway because the consequences of being
  -- wrong are unusually bad here: climb_uuid is part of this table's primary
  -- key, there is no FK/cascade from board_climbs, and deleteStaleGrades is
  -- itself scoped to CROWD_MEAN_BOARDS — so an orphaned MoonBoard grade row
  -- would never be reaped by anything. Unique key (board_type, climb_uuid,
  -- angle); survivor policy left at "canonical's own, else lowest
  -- computed_at" for the same reason as 5b. NOTE: this table has no delete
  -- trigger and no tombstone stream (docs/sync-table-manifest.md), so a device
  -- that somehow already held a MoonBoard grade row would keep the stale key
  -- until its next snapshot bootstrap.
  WITH ranked AS (
    SELECT bcg.ctid,
           ROW_NUMBER() OVER (
             PARTITION BY ids.canonical_uuid, bcg.angle
             ORDER BY (bcg.climb_uuid = ids.canonical_uuid) DESC, bcg.computed_at ASC, bcg.ctid ASC
           ) AS keep_rank
      FROM board_climb_grades bcg
      JOIN _mrd_all_ids ids ON ids.uuid = bcg.climb_uuid
     WHERE bcg.board_type = 'moonboard'
  )
  DELETE FROM board_climb_grades bcg USING ranked r
   WHERE bcg.ctid = r.ctid AND r.keep_rank > 1;
  UPDATE board_climb_grades bcg SET climb_uuid = m.canonical_uuid
    FROM _mrd_map m WHERE bcg.board_type = 'moonboard' AND bcg.climb_uuid = m.alias_uuid;

  -- 6. votes + vote_counts. Skip the per-row trigger during the bulk repoint
  --    (same guard rebuildGymVoteCounts() uses in merge-gyms.ts) so it
  --    doesn't do wasted/premature recomputes mid-repoint, dedupe among ALL
  --    members (same ranking shape as steps 4/5 — a user could have voted on
  --    two different losing members), repoint survivors, then rebuild
  --    vote_counts from scratch for every affected canonical using the exact
  --    trigger formula/created_at chain (see header).
  PERFORM set_config('boardsesh.skip_vote_counts', 'on', true);

  -- Policy: the user's LATEST vote survives (max created_at, tie max id).
  -- A vote is an opinion, not a record of an event — if a climber upvoted the
  -- 25° row in January and downvoted the 40° row in June, June is what they
  -- think of the problem now, so keeping the older row would resurrect an
  -- opinion they already changed. This is the one table here where the
  -- canonical's own row does NOT automatically win; that is safe because
  -- votes/vote_counts are not in any offline sync table config, so no client
  -- holds a row keyed on the entity_id being vacated.
  WITH ranked AS (
    SELECT v.id,
           ROW_NUMBER() OVER (
             PARTITION BY v.user_id, ids.canonical_uuid
             ORDER BY v.created_at DESC, v.id DESC
           ) AS keep_rank
      FROM votes v
      JOIN _mrd_all_ids ids ON ids.uuid = v.entity_id
     WHERE v.entity_type = 'climb'
  )
  DELETE FROM votes v USING ranked r
   WHERE v.id = r.id AND r.keep_rank > 1;
  UPDATE votes v SET entity_id = m.canonical_uuid
    FROM _mrd_map m WHERE v.entity_type = 'climb' AND v.entity_id = m.alias_uuid;

  DELETE FROM vote_counts vc
   WHERE vc.entity_type = 'climb'
     AND vc.entity_id IN (SELECT uuid FROM _mrd_all_ids);

  INSERT INTO vote_counts (entity_type, entity_id, upvotes, downvotes, score, hot_score, created_at)
  SELECT
    vote_totals.entity_type, vote_totals.entity_id, vote_totals.upvotes, vote_totals.downvotes, vote_totals.score,
    SIGN(vote_totals.score) * LN(GREATEST(ABS(vote_totals.score), 1))
      + EXTRACT(EPOCH FROM COALESCE(feed_created_at.created_at, vote_totals.first_vote_created_at, now())) / 45000.0,
    COALESCE(feed_created_at.created_at, vote_totals.first_vote_created_at, now())
  FROM (
    SELECT 'climb'::social_entity_type AS entity_type, m.canonical_uuid AS entity_id,
           SUM(CASE WHEN v.value = 1 THEN 1 ELSE 0 END)::int AS upvotes,
           SUM(CASE WHEN v.value = -1 THEN 1 ELSE 0 END)::int AS downvotes,
           SUM(v.value)::int AS score,
           MIN(v.created_at) AS first_vote_created_at
      FROM votes v
      JOIN (SELECT DISTINCT canonical_uuid FROM _mrd_map) m ON m.canonical_uuid = v.entity_id
     WHERE v.entity_type = 'climb'
     GROUP BY m.canonical_uuid
  ) vote_totals
  LEFT JOIN LATERAL (
    SELECT fi.created_at FROM feed_items fi
     WHERE fi.entity_type = vote_totals.entity_type AND fi.entity_id = vote_totals.entity_id
     ORDER BY fi.created_at ASC, fi.id ASC LIMIT 1
  ) feed_created_at ON true;

  PERFORM set_config('boardsesh.skip_vote_counts', 'off', true);

  -- 7. Recommendation/ML caches (see header for why dropping, not merging,
  --    is correct here).
  DELETE FROM board_climb_embeddings be USING _mrd_map m
   WHERE be.board_type = 'moonboard' AND be.climb_uuid = m.alias_uuid;

  DELETE FROM board_climb_similar bs USING _mrd_map m
   WHERE bs.board_type = 'moonboard' AND (bs.climb_uuid = m.alias_uuid OR bs.neighbor_uuid = m.alias_uuid);

  -- board_climb_send_stats has no angle dimension (PK is board_type+climb_uuid)
  -- and is a small PostHog-mined trending aggregate with no guaranteed
  -- near-term rebuild (unlike embeddings/similarity above), so its counts are
  -- merged rather than dropped. send_count_30d/90d are true event counts, so
  -- they sum cleanly. sender_count_30d is a DISTINCT-sender count we can't
  -- deduplicate here without the raw per-user PostHog rows (this migration
  -- only has each angle-row's already-aggregated count) — GREATEST is a
  -- deliberate conservative floor (correct if the two angle-rows' senders
  -- fully overlap, an undercount if they don't) rather than SUM, which would
  -- double-count any climber who sent both angle variants. Acceptable given
  -- the table's own "safe to be stale" contract; the next nightly job
  -- recomputes it properly from raw events regardless.
  -- Aliases are folded together FIRST, with the same per-column policy, for
  -- the same reason step 2 does it: a group with two alias members that both
  -- carry a row would feed one target key twice and trip "ON CONFLICT DO
  -- UPDATE command cannot affect row a second time", aborting the deploy.
  INSERT INTO board_climb_send_stats (board_type, climb_uuid, send_count_30d, sender_count_30d, send_count_90d, last_sent_at, updated_at)
  SELECT 'moonboard', m.canonical_uuid,
         SUM(s.send_count_30d)::int, MAX(s.sender_count_30d), SUM(s.send_count_90d)::int,
         MAX(s.last_sent_at), now()
    FROM board_climb_send_stats s
    JOIN _mrd_map m ON m.alias_uuid = s.climb_uuid
   WHERE s.board_type = 'moonboard'
   GROUP BY m.canonical_uuid
  ON CONFLICT (board_type, climb_uuid) DO UPDATE SET
    send_count_30d = board_climb_send_stats.send_count_30d + excluded.send_count_30d,
    sender_count_30d = GREATEST(board_climb_send_stats.sender_count_30d, excluded.sender_count_30d),
    send_count_90d = board_climb_send_stats.send_count_90d + excluded.send_count_90d,
    last_sent_at = GREATEST(board_climb_send_stats.last_sent_at, excluded.last_sent_at),
    updated_at = now();

  DELETE FROM board_climb_send_stats s USING _mrd_map m
   WHERE s.board_type = 'moonboard' AND s.climb_uuid = m.alias_uuid;

  -- 8. Delist the non-canonical rows. Never DELETE (see header): their
  --    board_climb_holds/self-alias rows stay in place as harmless, unlisted
  --    history.
  --    Offline propagation: is_listed is a SYNCED column, not a server-side
  --    filter — clients hold it and filter locally — and
  --    trg_board_climbs_set_sync_fields (0144/0146) bumps updated_at/sync_seq
  --    on any change outside its excluded set, which is what carries the flip
  --    past every device's cursor. No tombstone: the row still exists. The
  --    IS DISTINCT FROM guard keeps the trigger's WHEN clause honest — an
  --    already-false row must not be re-shipped to every client for nothing,
  --    and it makes the statement's row count the true "how many delisted".
  UPDATE board_climbs
     SET is_listed = false
   WHERE board_type = 'moonboard'
     AND is_listed IS DISTINCT FROM false
     AND uuid IN (SELECT alias_uuid FROM _mrd_map);

  INSERT INTO _bs_migration_guards (tag) VALUES ('moonboard_residual_dedup_5253');

  SELECT count(*) INTO v_recomputed FROM _mrd_recompute_keys;
  SELECT count(*) INTO v_tombstones FROM sync_deletions WHERE id > v_tombstone_watermark;

  RAISE NOTICE 'moonboard residual dedup: merged % non-canonical row(s) across % group(s); left % conflicting-redirect group(s) untouched; recomputed % stats key(s); wrote % offline tombstone(s)',
    v_merged, v_groups, v_skipped_ambiguous, v_recomputed, v_tombstones;
END $$;
