-- Custom SQL migration file, put your code below! --

-- `pg_restore` opens every restore with
--
--   SELECT pg_catalog.set_config('search_path', '', false);
--
-- deliberately, so objects in a schema earlier on the path cannot hijack the
-- restore. plpgsql resolves the unqualified names in a function body against
-- whatever `search_path` is current, so a trigger function with no pinned path
-- of its own is unresolvable while that setting is in force -- even though
-- PostGIS, the enums and every application table are all in `public`.
--
-- Two of the fourteen trigger functions fire on INSERT and therefore run
-- during `COPY`, which is what a data-only restore is:
--
--   set_location_from_coordinates()  0127; gyms_set_location,
--                                    user_boards_set_location
--     pg_restore: error: COPY failed for table "user_boards":
--     ERROR:  type "geography" does not exist
--     CONTEXT:  PL/pgSQL function public.set_location_from_coordinates()
--               line 4 at assignment
--
--   update_vote_counts()             0053/0130; votes_count_trigger
--     pg_restore: error: COPY failed for table "votes":
--     ERROR:  type "social_entity_type" does not exist
--     CONTEXT:  compilation of PL/pgSQL function "update_vote_counts"
--               near line 3
--
-- `update_vote_counts` fails at *compilation*, on the `DECLARE v_entity_type
-- social_entity_type`, strictly before its `boardsesh.skip_vote_counts` early
-- return on line 11 can run -- so the skip guard cannot rescue it. Pinning
-- only `set_location_from_coordinates` moves the abort from the first spatial
-- table to `votes` and still leaves a data-only reload needing
-- `--disable-triggers`, and therefore a superuser.
--
-- The other twelve fire only on UPDATE or DELETE, so `COPY` never reaches
-- them, but they carry the identical defect: unqualified `sync_deletions`,
-- `playlists`, `playlist_ownership`, and a `nextval()` naming its sequence as
-- a bare string. Pinning all fourteen is one line each, changes nothing for
-- application writes (every app session already has `public` first), and
-- leaves no "why is that one pinned and this one not" for the next migration
-- to get wrong. `postgis_cache_bbox()` is a fifteenth `RETURNS trigger`
-- function in `public`, but it belongs to the PostGIS extension: it is not
-- ours to ALTER, and the guards that check this invariant exclude it via
-- `pg_depend.deptype = 'e'`.
--
-- The scope is narrower than the error first suggests, and worth stating
-- exactly, because it decides how much this matters. Verified on PostgreSQL
-- 18.4:
--
--   full pg_dump -> pg_restore    UNAFFECTED. pg_dump emits CREATE TRIGGER
--                                 after COPY, so the trigger does not exist
--                                 yet while the data loads.
--   --data-only restore into an   BROKEN. The trigger is already there, fires
--   existing schema               during COPY, and the restore aborts with
--                                 zero rows loaded.
--   application writes            UNAFFECTED; the app search_path has public.
--   PG18 logical-replication      UNAFFECTED. A subscriber applies with
--   initial copy                  session_replication_role = replica, which
--                                 fires only ENABLE ALWAYS/REPLICA triggers,
--                                 and this schema has none.
--
-- So this is not a broken backup, and the runbook restore drill was never at
-- risk. It is a footgun on any data-only reload.
--
-- None of these are SECURITY DEFINER, so this is a name-resolution fix and not
-- a privilege boundary. `public, pg_catalog` rather than `pg_catalog, public`:
-- pg_catalog is searched first whether listed or not, and naming it last lets
-- an unqualified name resolve against public first, which is where PostGIS,
-- the enums and every application table live. Nothing this repo creates in
-- public shadows a pg_catalog builtin; if one ever does, flip the order.
--
-- ALTER rather than CREATE OR REPLACE with the body restated (which is what
-- 0130, 0146 and 0147 do): an ALTER cannot drift a body away from whatever is
-- actually live in production. `ALTER FUNCTION ... SET` is idempotent, takes
-- no table lock, and reverses with `RESET search_path`.
--
-- Found by scripts/postgres18-spatial-rehearsal.sh, which copies data into a
-- target whose schema is already loaded and so takes the broken path. See
-- #4699 and docs/postgres-18-postgis-rehearsal.md.

-- The two that fire on INSERT and so run during COPY.
ALTER FUNCTION set_location_from_coordinates() SET search_path = public, pg_catalog;--> statement-breakpoint
ALTER FUNCTION update_vote_counts() SET search_path = public, pg_catalog;--> statement-breakpoint

-- The twelve that fire only on UPDATE or DELETE.
ALTER FUNCTION set_updated_at() SET search_path = public, pg_catalog;--> statement-breakpoint
ALTER FUNCTION set_board_climbs_sync_fields() SET search_path = public, pg_catalog;--> statement-breakpoint
ALTER FUNCTION set_board_climb_stats_sync_fields() SET search_path = public, pg_catalog;--> statement-breakpoint
ALTER FUNCTION log_deletion_ticks() SET search_path = public, pg_catalog;--> statement-breakpoint
ALTER FUNCTION log_deletion_playlists() SET search_path = public, pg_catalog;--> statement-breakpoint
ALTER FUNCTION log_deletion_playlist_climbs() SET search_path = public, pg_catalog;--> statement-breakpoint
ALTER FUNCTION log_deletion_favorites() SET search_path = public, pg_catalog;--> statement-breakpoint
ALTER FUNCTION log_deletion_user_follows() SET search_path = public, pg_catalog;--> statement-breakpoint
ALTER FUNCTION log_deletion_setter_follows() SET search_path = public, pg_catalog;--> statement-breakpoint
ALTER FUNCTION log_deletion_playlist_follows() SET search_path = public, pg_catalog;--> statement-breakpoint
ALTER FUNCTION log_deletion_board_climbs() SET search_path = public, pg_catalog;--> statement-breakpoint
ALTER FUNCTION log_deletion_board_climb_stats() SET search_path = public, pg_catalog;
