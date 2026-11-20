-- Remove the "Only me" stamps inferred-session reconciliation put on ticks, and
-- read legacy private session policies as unlisted.
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
-- Precondition, confirmed by the owner on 2026-10-12: the flag was never enabled
-- in production (BOARDSESH_PRIVACY_ENABLED; the default is off, docs/privacy.md
-- and #6273). With the flag off nobody could pick a tick or session audience
-- (setContentAudience and updateResourcePrivacy go through privacyActor), so
-- every row this touches was written by the server. It also covers two
-- reconcile quirks: its upsert never touched updated_at, so a tick row it
-- overwrote keeps the older row's time (a pre-2026-10-09 row is missed and stays
-- Only me; a row written after it and then overwritten is removed and falls back
-- to the account default).
--
-- Second block: session policies the legacy switch wrote as invite_only.
-- After #6254 an old or flag-off client's Private switch, reconcile merges and
-- splits of a private source, and session creation all wrote
-- resource_privacy (session, invite_only) from the is_public boolean, not from a
-- choice. With the flag off nobody can approve a request, so those links were
-- dead. A legacy private session now means unlisted (off the listings, the link
-- joins), so those rows become unlisted. Same guards: written on or after
-- 2026-10-09, the session's is_public is false, and the owner never changed their
-- account privacy or chose a session default.
--
-- Dry run for the second block:
--   SELECT COUNT(*) FROM resource_privacy policy
--   JOIN board_sessions session ON session.id = policy.resource_id AND session.is_public = false
--   WHERE policy.kind = 'session' AND policy.audience = 'invite_only'
--     AND policy.updated_at >= '2026-10-09'
--     AND NOT EXISTS (SELECT 1 FROM user_profiles profile WHERE profile.user_id = policy.owner_id
--                     AND (profile.privacy_revision <> 0 OR profile.default_session_audience IS NOT NULL));
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
END $$;--> statement-breakpoint

DO $$
DECLARE
  v_remapped bigint;
BEGIN
  IF EXISTS (SELECT 1 FROM _bs_migration_guards WHERE tag = 'privacy_legacy_private_sessions_unlisted') THEN
    RAISE NOTICE 'Legacy private session policies already remapped (guard row present)';
    RETURN;
  END IF;

  UPDATE resource_privacy policy
  SET audience = 'unlisted', revision = policy.revision + 1, updated_at = now()
  FROM board_sessions session
  WHERE session.id = policy.resource_id
    AND session.is_public = false
    AND policy.kind = 'session'
    AND policy.audience = 'invite_only'
    AND policy.updated_at >= '2026-10-09'
    AND NOT EXISTS (
      SELECT 1 FROM user_profiles profile
      WHERE profile.user_id = policy.owner_id
        AND (profile.privacy_revision <> 0 OR profile.default_session_audience IS NOT NULL)
    );
  GET DIAGNOSTICS v_remapped = ROW_COUNT;
  RAISE NOTICE 'Remapped % legacy private session policies to unlisted', v_remapped;

  INSERT INTO _bs_migration_guards (tag) VALUES ('privacy_legacy_private_sessions_unlisted');
END $$;
