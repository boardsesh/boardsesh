-- Custom SQL migration file, put your code below! --
--
-- One-time global backfill: rebuild boardsesh_ascensionist_count,
-- ascensionist_count, and FA for EVERY (board_type, climb_uuid, angle) that has
-- ≥1 flash/send tick, using the new provenance-aware counting rule (origin was
-- stamped by migration 0156). This repairs the ~193k double-counted ascents:
-- every user with an imported tick at a key was being counted a second time on
-- top of upstream_ascensionist_count.
--
-- New boardsesh_ascensionist_count rule (matches
-- packages/db/src/queries/climb-stats/recompute.ts exactly, so the first live
-- recompute after this migration is a no-op — no churn):
--   COUNT of DISTINCT users who have ≥1 flash/send tick at the key AND have NO
--   FLASH/SEND tick at the key with origin <> 'native' (per-user bool_or
--   guard; imported attempts don't disqualify — upstream counts have no bids).
--
-- FA repair (non-owned / manufacturer climbs only): the manufacturer owns the
-- authoritative FA on these climbs, so NO Boardsesh tick — native or imported —
-- should ever have crowned them. The old recompute nonetheless derived FA from
-- the earliest flash/send tick, planting wrong crowns (e.g. MoonBoard problems,
-- whose upstream supplies no FA at all, "crowned" by a Boardsesh log). Detect
-- the tick-derived signature — stored fa_username AND fa_at exactly match the
-- earliest flash/send tick at the key, of ANY origin — and CLEAR it to NULL.
-- The fa_at exact-match guard is the discriminator: an upstream-supplied FA (on
-- Kilter/Tension) carries the manufacturer's own first-ascent timestamp, which
-- does not coincide with a Boardsesh tick's climbed_at, so it's preserved
-- verbatim. Boardsesh-owned climbs keep re-deriving FA from all ticks.
-- Upstream syncs re-fill the authoritative FA on their next pass (the catalog
-- upsert COALESCE-fills a NULL fa); MoonBoard rows, having no upstream FA,
-- correctly end NULL.
--
-- Prod-verified (2026-07 snapshot, pre-migration reconstruction): the clear
-- matches ~700 non-owned rows (predominantly MoonBoard native-derived crowns,
-- ~617; kilter ~57; tension ~6). Count jitters by a handful with the earliest-
-- tick tie-break, as does this migration. Non-owned rows whose fa_username
-- matches a tick crown but whose fa_at has drifted from the current earliest
-- tick (a since-imported earlier ascent) are deliberately NOT cleared — the
-- fa_at guard cannot prove they're tick-derived without risking an upstream FA.
--
-- Chunked in batches of 2,000 keys: a single-pass GROUP BY over the whole
-- boardsesh_ticks × board_climb_stats join exhausts prod's work_mem / parallel
-- shared memory. The per-batch set-based UPDATE keeps the working set bounded.
--
-- Idempotent: recomputes purely from ticks + stamped origin, so re-running
-- produces the same result. A cleared (NULL) non-owned FA no longer matches the
-- earliest tick's crown, so a re-run leaves it NULL — the repair is a fixpoint.
-- Quality/difficulty averages are intentionally NOT touched here (out of scope
-- for this backfill) — they self-correct on the next per-key recompute.
--
-- Offline propagation: every per-row UPDATE below whose values actually change
-- fires the BEFORE UPDATE trigger trg_board_climb_stats_set_sync_fields (added
-- in 0144, WHEN-guarded on OLD.* IS DISTINCT FROM NEW.* in 0146), which bumps
-- updated_at = now() and sync_seq = nextval(). The offline pull cursor for
-- board_climb_stats is exactly (updated_at, sync_seq) (backend syncClimbStats),
-- so the corrected counts reach mobile clients as a bounded, one-time re-pull of
-- only the rows this backfill changed. No-op rows (already correct) don't fire
-- the trigger and are not re-shipped. Nothing here bumps the cursor manually —
-- the trigger is the single mechanism, shared with the live bulk recompute.

DO $$
DECLARE
  b bigint;
  max_batch bigint;
BEGIN
  -- All keys that carry at least one flash/send tick, numbered into batches.
  CREATE TEMP TABLE _bf_recompute_keys ON COMMIT DROP AS
    SELECT board_type, climb_uuid, angle,
           ((row_number() OVER (ORDER BY board_type, climb_uuid, angle)) - 1) / 2000 AS batch
      FROM (
        SELECT DISTINCT board_type, climb_uuid, angle
          FROM boardsesh_ticks
         WHERE status IN ('flash','send')
      ) distinct_keys;
  CREATE INDEX ON _bf_recompute_keys (batch);

  -- Ensure a stats row exists for every key (ticks can predate the saveClimb
  -- seed, or land at an angle the seed didn't cover). Upstream stays 0.
  INSERT INTO board_climb_stats (board_type, climb_uuid, angle,
                                 ascensionist_count, upstream_ascensionist_count, boardsesh_ascensionist_count)
  SELECT board_type, climb_uuid, angle, 0, 0, 0
    FROM _bf_recompute_keys
  ON CONFLICT (board_type, climb_uuid, angle) DO NOTHING;

  SELECT COALESCE(MAX(batch), -1) INTO max_batch FROM _bf_recompute_keys;

  FOR b IN 0..max_batch LOOP
    WITH keys AS (
      SELECT board_type, climb_uuid, angle FROM _bf_recompute_keys WHERE batch = b
    ),
    per_user AS (
      SELECT bt.board_type, bt.climb_uuid, bt.angle, bt.user_id,
             bool_or(bt.status IN ('flash','send')) AS has_send,
             -- Only imported flash/send ticks mark upstream representation:
             -- upstream ascent counts don't include bids, so an imported
             -- attempt must not disqualify a native send.
             bool_or(bt.origin <> 'native' AND bt.status IN ('flash','send')) AS has_upstream
        FROM boardsesh_ticks bt
        JOIN keys k
          ON k.board_type = bt.board_type AND k.climb_uuid = bt.climb_uuid AND k.angle = bt.angle
       GROUP BY bt.board_type, bt.climb_uuid, bt.angle, bt.user_id
    ),
    counts AS (
      SELECT board_type, climb_uuid, angle,
             COUNT(*) FILTER (WHERE has_send AND NOT has_upstream) AS distinct_senders
        FROM per_user
       GROUP BY board_type, climb_uuid, angle
    ),
    earliest_any AS (
      SELECT DISTINCT ON (bt.board_type, bt.climb_uuid, bt.angle)
             bt.board_type, bt.climb_uuid, bt.angle,
             bt.climbed_at                     AS first_at,
             COALESCE(up.display_name, u.name) AS crown
        FROM boardsesh_ticks bt
        JOIN keys k
          ON k.board_type = bt.board_type AND k.climb_uuid = bt.climb_uuid AND k.angle = bt.angle
        JOIN users u ON u.id = bt.user_id
   LEFT JOIN user_profiles up ON up.user_id = u.id
       WHERE bt.status IN ('flash','send')
       ORDER BY bt.board_type, bt.climb_uuid, bt.angle, bt.climbed_at ASC
    )
    UPDATE board_climb_stats s
       SET boardsesh_ascensionist_count = COALESCE(c.distinct_senders, 0),
           ascensionist_count           = COALESCE(s.upstream_ascensionist_count, 0)
                                        + COALESCE(c.distinct_senders, 0),
           -- Owned climbs re-derive FA from the earliest tick. Non-owned climbs:
           -- CLEAR a tick-derived crown (stored fa exactly matches the earliest
           -- flash/send tick, any origin) to NULL; otherwise preserve the
           -- upstream-supplied FA verbatim.
           fa_username = CASE
             WHEN owned.boardsesh_owned THEN ea.crown
             WHEN s.fa_username IS NOT DISTINCT FROM ea.crown
              AND s.fa_at       IS NOT DISTINCT FROM ea.first_at
               THEN NULL
             ELSE s.fa_username
           END,
           fa_at = CASE
             WHEN owned.boardsesh_owned THEN ea.first_at
             WHEN s.fa_username IS NOT DISTINCT FROM ea.crown
              AND s.fa_at       IS NOT DISTINCT FROM ea.first_at
               THEN NULL
             ELSE s.fa_at
           END
      FROM keys k
      LEFT JOIN counts c
        ON c.board_type = k.board_type AND c.climb_uuid = k.climb_uuid AND c.angle = k.angle
      LEFT JOIN earliest_any ea
        ON ea.board_type = k.board_type AND ea.climb_uuid = k.climb_uuid AND ea.angle = k.angle
      LEFT JOIN LATERAL (
        SELECT COALESCE(
                 (SELECT bc.user_id IS NOT NULL
                    FROM board_climbs bc
                   WHERE bc.board_type = k.board_type AND bc.uuid = k.climb_uuid),
                 FALSE) AS boardsesh_owned
      ) owned ON TRUE
     WHERE s.board_type = k.board_type
       AND s.climb_uuid = k.climb_uuid
       AND s.angle      = k.angle;
  END LOOP;
END $$;
