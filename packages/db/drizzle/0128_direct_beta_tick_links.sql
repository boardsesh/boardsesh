ALTER TABLE "board_beta_links" ADD COLUMN IF NOT EXISTS "tick_uuid" text;--> statement-breakpoint
ALTER TABLE "board_beta_links" ADD COLUMN IF NOT EXISTS "board_id" bigint;--> statement-breakpoint
ALTER TABLE "board_beta_links" ADD COLUMN IF NOT EXISTS "video_identity" text;--> statement-breakpoint

WITH parsed_links AS (
  SELECT
    ctid AS row_id,
    link,
    regexp_match(link, '^https://(www\.)?(instagram\.com|instagr\.am)/(p|reel|tv)/([[:alnum:]_-]+)/?([?#].*)?$', 'i') AS instagram_match,
    regexp_match(link, '^https://([a-z0-9-]+\.)*tiktok\.com/@[A-Za-z0-9_.-]+/video/([0-9]+)', 'i') AS tiktok_match
  FROM board_beta_links
),
identity_candidates AS (
  SELECT
    row_id,
    CASE
      WHEN instagram_match IS NOT NULL THEN 'instagram:' || instagram_match[4]
      WHEN tiktok_match IS NOT NULL THEN 'tiktok:' || tiktok_match[2]
      ELSE 'raw:' || link
    END AS video_identity
  FROM parsed_links
),
ranked_identities AS (
  SELECT
    bl.ctid AS row_id,
    identity_candidates.video_identity,
    row_number() OVER (
      PARTITION BY identity_candidates.video_identity
      ORDER BY
        (bl.created_by_user_id IS NOT NULL) DESC,
        bl.created_at DESC NULLS LAST,
        (bl.thumbnail IS NOT NULL) DESC,
        bl.board_type,
        bl.climb_uuid,
        bl.link
    ) AS identity_rank
  FROM board_beta_links bl
  INNER JOIN identity_candidates ON identity_candidates.row_id = bl.ctid
)
UPDATE board_beta_links bl
SET video_identity = ranked_identities.video_identity
FROM ranked_identities
WHERE bl.ctid = ranked_identities.row_id
  AND ranked_identities.identity_rank = 1;--> statement-breakpoint

WITH beta_candidates AS (
  SELECT
    bl.ctid AS beta_row_id,
    t.uuid AS tick_uuid,
    t.board_id AS board_id,
    count(*) OVER (PARTITION BY bl.ctid) AS beta_candidate_count,
    count(*) OVER (PARTITION BY t.uuid) AS tick_candidate_count
  FROM board_beta_links bl
  INNER JOIN boardsesh_ticks t
    ON t.user_id = bl.created_by_user_id
    AND t.board_type = bl.board_type
    AND t.status IN ('flash', 'send')
    AND (bl.angle IS NULL OR bl.angle = t.angle)
  LEFT JOIN board_climb_aliases bca_tick
    ON bca_tick.board_type = t.board_type
    AND bca_tick.alias_uuid = t.climb_uuid
  WHERE bl.video_identity IS NOT NULL
    AND bl.created_by_user_id IS NOT NULL
    AND COALESCE(bca_tick.canonical_uuid, t.climb_uuid) = bl.climb_uuid
),
safe_matches AS (
  SELECT beta_row_id, tick_uuid, board_id
  FROM beta_candidates
  WHERE beta_candidate_count = 1
    AND tick_candidate_count = 1
)
UPDATE board_beta_links bl
SET
  tick_uuid = safe_matches.tick_uuid,
  board_id = safe_matches.board_id
FROM safe_matches
WHERE bl.ctid = safe_matches.beta_row_id;--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'board_beta_links_tick_uuid_boardsesh_ticks_uuid_fk'
      AND conrelid = '"board_beta_links"'::regclass
  ) THEN
    ALTER TABLE "board_beta_links"
      ADD CONSTRAINT "board_beta_links_tick_uuid_boardsesh_ticks_uuid_fk"
      FOREIGN KEY ("tick_uuid") REFERENCES "public"."boardsesh_ticks"("uuid") ON DELETE SET NULL ON UPDATE NO ACTION;
  END IF;
END $$;--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'board_beta_links_board_id_user_boards_id_fk'
      AND conrelid = '"board_beta_links"'::regclass
  ) THEN
    ALTER TABLE "board_beta_links"
      ADD CONSTRAINT "board_beta_links_board_id_user_boards_id_fk"
      FOREIGN KEY ("board_id") REFERENCES "public"."user_boards"("id") ON DELETE SET NULL ON UPDATE NO ACTION;
  END IF;
END $$;--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "board_beta_links_video_identity_unique" ON "board_beta_links" USING btree ("video_identity") WHERE "board_beta_links"."video_identity" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "board_beta_links_tick_uuid_unique" ON "board_beta_links" USING btree ("tick_uuid") WHERE "board_beta_links"."tick_uuid" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "board_beta_links_board_id_idx" ON "board_beta_links" USING btree ("board_id") WHERE "board_beta_links"."board_id" IS NOT NULL;
