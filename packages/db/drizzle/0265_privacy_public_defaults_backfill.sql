-- Custom SQL migration file, put your code below! --
--
-- Put back the public defaults that #6254 flipped (privacy-correction series,
-- PR B1). #6254 made new home boards private and, behind
-- BOARDSESH_PRIVACY_ENABLED, new accounts private. The owner ruled both wrong:
-- new home boards are public with the exact location hidden, and new accounts
-- are public with Private as an opt-in. Followers is also no longer a location
-- audience, so stored followers locations narrow to invited people.
--
-- Cutoff: #6254 merged at 2026-10-08 21:27:51 UTC. Nothing older can carry the
-- flipped default: the server default needed that backend, and the builder
-- default needed the OTA published from that push. The cutoff assumes
-- created_at holds UTC: it is a timestamp without time zone filled by now() in
-- the writing session's TimeZone, so check `SHOW timezone;` before trusting
-- the dry run.
--
-- Only rows that still look exactly like the untouched #6254 default change.
-- That default was private with the location hidden, written in one insert:
--   * boards: not deleted, not the system catalogue owner, not a spray wall
--     (a spray wall is created private on purpose and goes public only on its
--     first publish, see docs/spray-walls.md), no access grants, location
--     hidden (hide_location = true), never edited (updated_at = created_at:
--     createBoard writes both in one statement, every updateBoard bumps
--     updated_at, the geography sync does not), and either no policy row at
--     all (the legacy-boolean create) or an `only_me` policy row with an
--     `only_me` location nobody has edited (revision 0). A private board with
--     its location shown, or one switched private after creation, was a
--     deliberate choice and stays private. hide_location is never touched.
--   * profiles: private with the followers session default, never edited
--     (privacy revision 0, setup never completed, updated_at = created_at).
--     Expected to change no rows in production: the flag was never turned on.
--
-- A board a climber makes private after this runs can look the same as a
-- default one, so a second run could undo their choice. The guard row below
-- makes this run exactly once; its tag is a semantic identity and must NOT
-- change if the file is renumbered.
--
-- Dry run (same predicates, read-only):
--
--   SHOW timezone;
--
--   -- boards with no policy row
--   SELECT count(*) FROM user_boards b
--    WHERE b.deleted_at IS NULL AND b.created_at >= '2026-10-08 21:27:51'
--      AND b.is_public = false AND b.is_unlisted = false AND b.hide_location = true
--      AND b.updated_at = b.created_at AND b.board_type <> 'spray'
--      AND b.owner_id <> '00000000-0000-0000-0000-000000000000'
--      AND NOT EXISTS (SELECT 1 FROM resource_privacy p WHERE p.kind = 'board' AND p.resource_id = b.uuid)
--      AND NOT EXISTS (SELECT 1 FROM resource_grants g WHERE g.kind = 'board' AND g.resource_id = b.uuid);
--
--   -- boards with an untouched Only me policy row
--   SELECT count(*) FROM user_boards b
--     JOIN resource_privacy p ON p.kind = 'board' AND p.resource_id = b.uuid
--    WHERE b.deleted_at IS NULL AND b.created_at >= '2026-10-08 21:27:51'
--      AND b.is_unlisted = false AND b.hide_location = true AND b.updated_at = b.created_at
--      AND b.board_type <> 'spray' AND b.owner_id <> '00000000-0000-0000-0000-000000000000'
--      AND p.audience = 'only_me' AND p.location_audience = 'only_me' AND p.revision = 0
--      AND NOT EXISTS (SELECT 1 FROM resource_grants g WHERE g.kind = 'board' AND g.resource_id = b.uuid);
--
--   -- NOT changed, for the owner to decide: default-shaped boards edited since
--   -- creation (a rename or serial bind looks the same as a privacy switch)
--   SELECT count(*) FROM user_boards b
--    WHERE b.deleted_at IS NULL AND b.created_at >= '2026-10-08 21:27:51'
--      AND b.is_public = false AND b.is_unlisted = false AND b.hide_location = true
--      AND b.updated_at > b.created_at AND b.board_type <> 'spray'
--      AND b.owner_id <> '00000000-0000-0000-0000-000000000000'
--      AND NOT EXISTS (SELECT 1 FROM resource_privacy p WHERE p.kind = 'board' AND p.resource_id = b.uuid)
--      AND NOT EXISTS (SELECT 1 FROM resource_grants g WHERE g.kind = 'board' AND g.resource_id = b.uuid);
--
--   -- followers locations, narrowed to invited people (any date)
--   SELECT count(*) FROM resource_privacy WHERE location_audience = 'followers';
--
--   -- accounts
--   SELECT count(*) FROM user_profiles
--    WHERE is_private AND default_session_audience = 'followers'
--      AND privacy_revision = 0 AND privacy_onboarding_version = 0
--      AND updated_at = created_at AND created_at >= '2026-10-08 21:27:51';

CREATE TABLE IF NOT EXISTS _bs_migration_guards (
  tag text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint

DO $$
DECLARE
  v_boards bigint;
  v_policy_boards bigint;
  v_locations bigint;
  v_profiles bigint;
BEGIN
  IF EXISTS (SELECT 1 FROM _bs_migration_guards WHERE tag = 'privacy_public_defaults_backfill_b1') THEN
    RAISE NOTICE 'Privacy public-defaults backfill already applied, skipping (guard row present)';
    RETURN;
  END IF;

  -- Boards created through the legacy booleans with the flipped default.
  UPDATE user_boards b
     SET is_public = true
   WHERE b.deleted_at IS NULL
     AND b.created_at >= '2026-10-08 21:27:51'
     AND b.is_public = false
     AND b.is_unlisted = false
     AND b.hide_location = true
     AND b.updated_at = b.created_at
     AND b.board_type <> 'spray'
     AND b.owner_id <> '00000000-0000-0000-0000-000000000000'
     AND NOT EXISTS (
       SELECT 1 FROM resource_privacy p WHERE p.kind = 'board' AND p.resource_id = b.uuid
     )
     AND NOT EXISTS (
       SELECT 1 FROM resource_grants g WHERE g.kind = 'board' AND g.resource_id = b.uuid
     );
  GET DIAGNOSTICS v_boards = ROW_COUNT;

  -- Boards whose untouched policy row says Only me, location included. The
  -- policy and its legacy projection move together, so old readers and new
  -- readers agree.
  WITH reset AS (
    UPDATE resource_privacy p
       SET audience = 'public',
           updated_at = now()
      FROM user_boards b
     WHERE p.kind = 'board'
       AND p.resource_id = b.uuid
       AND p.audience = 'only_me'
       AND p.location_audience = 'only_me'
       AND p.revision = 0
       AND b.deleted_at IS NULL
       AND b.created_at >= '2026-10-08 21:27:51'
       AND b.is_unlisted = false
       AND b.hide_location = true
       AND b.updated_at = b.created_at
       AND b.board_type <> 'spray'
       AND b.owner_id <> '00000000-0000-0000-0000-000000000000'
       AND NOT EXISTS (
         SELECT 1 FROM resource_grants g WHERE g.kind = 'board' AND g.resource_id = b.uuid
       )
    RETURNING p.resource_id
  )
  UPDATE user_boards b
     SET is_public = true
    FROM reset
   WHERE b.uuid = reset.resource_id;
  GET DIAGNOSTICS v_policy_boards = ROW_COUNT;

  -- Followers is no longer a location audience: on a public account follows
  -- are approved automatically, so it restricted nothing. Narrow it to invited
  -- people, as the server now does on every write. The legacy projection
  -- (hide_location) is already true for a followers location.
  UPDATE resource_privacy
     SET location_audience = 'members',
         updated_at = now()
   WHERE location_audience = 'followers';
  GET DIAGNOSTICS v_locations = ROW_COUNT;

  -- Accounts created private by the flag, untouched since.
  UPDATE user_profiles
     SET is_private = false,
         default_session_audience = NULL,
         updated_at = now()
   WHERE is_private
     AND default_session_audience = 'followers'
     AND privacy_revision = 0
     AND privacy_onboarding_version = 0
     AND updated_at = created_at
     AND created_at >= '2026-10-08 21:27:51';
  GET DIAGNOSTICS v_profiles = ROW_COUNT;

  INSERT INTO _bs_migration_guards (tag) VALUES ('privacy_public_defaults_backfill_b1');

  RAISE NOTICE 'Privacy public-defaults backfill: % boards without a policy, % boards with an Only me policy, % followers locations narrowed, % accounts',
    v_boards, v_policy_boards, v_locations, v_profiles;
END $$;
