-- Remove the "Only me" stamps inferred-session reconciliation put on ticks.
--
-- From #6254 (merged 2026-10-09) until this release, reconciling a climber's
-- inferred sessions wrote content_privacy (tick, only_me) for every tick it
-- absorbed into an explicit session whose policy it could not express as an
-- item audience. The climber never chose those audiences; their ticks simply
-- vanished from their followers' feeds. A tick's audience now follows its
-- author only, reconciliation no longer writes them, and this removes the ones
-- it already wrote.
--
-- A row is treated as a reconciliation stamp only when every one of these holds:
--   * it is a tick row with audience only_me, last written on or after 2026-10-09;
--   * the tick sits in an explicit session today, which is where reconciliation
--     put every tick it stamped;
--   * its owner never changed their account privacy (privacy_revision 0, or no
--     profile row, which reads as 0);
--   * its owner has no content_privacy row carrying public consent, i.e. they
--     have never made an explicit audience choice that this could be mistaken for.
-- Anything else, including an "Only me" a climber picked on a tick that is not
-- in an explicit session, is left alone.
--
-- Dry run (read-only, run against the primary before deploying):
--   SELECT COUNT(*) FROM content_privacy stamp
--   WHERE stamp.entity_type = 'tick' AND stamp.audience = 'only_me'
--     AND stamp.updated_at >= '2026-10-09'
--     AND EXISTS (SELECT 1 FROM boardsesh_ticks tick JOIN board_sessions session ON session.id = tick.session_id
--                 WHERE tick.uuid = stamp.entity_id AND session.origin = 'explicit')
--     AND NOT EXISTS (SELECT 1 FROM user_profiles profile
--                     WHERE profile.user_id = stamp.owner_id AND profile.privacy_revision <> 0)
--     AND NOT EXISTS (SELECT 1 FROM content_privacy consent
--                     WHERE consent.owner_id = stamp.owner_id AND consent.public_consent_revision IS NOT NULL);
--
-- Generated with drizzle-kit generate --custom. The durable guard below is a
-- semantic identity and must NOT change when the migration is renumbered.

CREATE TABLE IF NOT EXISTS _bs_migration_guards (
  tag text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint

DO $$
DECLARE
  v_removed bigint;
BEGIN
  IF EXISTS (SELECT 1 FROM _bs_migration_guards WHERE tag = 'privacy_reconcile_tick_tombstones_author_decides') THEN
    RAISE NOTICE 'Reconciliation tick stamps already removed (guard row present)';
    RETURN;
  END IF;

  DELETE FROM content_privacy stamp
  WHERE stamp.entity_type = 'tick'
    AND stamp.audience = 'only_me'
    AND stamp.updated_at >= '2026-10-09'
    AND EXISTS (
      SELECT 1 FROM boardsesh_ticks tick
      JOIN board_sessions session ON session.id = tick.session_id
      WHERE tick.uuid = stamp.entity_id AND session.origin = 'explicit'
    )
    AND NOT EXISTS (
      SELECT 1 FROM user_profiles profile
      WHERE profile.user_id = stamp.owner_id AND profile.privacy_revision <> 0
    )
    AND NOT EXISTS (
      SELECT 1 FROM content_privacy consent
      WHERE consent.owner_id = stamp.owner_id AND consent.public_consent_revision IS NOT NULL
    );
  GET DIAGNOSTICS v_removed = ROW_COUNT;
  RAISE NOTICE 'Removed % reconciliation tick stamps', v_removed;

  INSERT INTO _bs_migration_guards (tag) VALUES ('privacy_reconcile_tick_tombstones_author_decides');
END $$;
