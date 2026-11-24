-- The schema-only migration and this journaled custom migration perform no backfill.
-- Source writers share dependency locks. A short observing transaction may take
-- them exclusively but reads source rows through MVCC and acquires no row locks.
-- Trigger functions must work before the deploy reconciles runtime table ACL.
SET LOCAL lock_timeout = '1s';
--> statement-breakpoint
CREATE FUNCTION public.spray_exposure_fence_key(dependency text, source_key text) RETURNS bigint
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE SET search_path = pg_catalog
AS $key$
  SELECT hashtextextended('boardsesh:production:spray-exposure:' || dependency || ':' || source_key, 7969)
$key$;
--> statement-breakpoint
CREATE FUNCTION public.spray_exposure_invalidate(dependency text, source_key text, fence_key text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $body$
BEGIN
  PERFORM pg_advisory_xact_lock_shared(public.spray_exposure_fence_key(
    CASE WHEN dependency = 'policy' THEN 'board' ELSE dependency END, coalesce(fence_key, source_key)
  ));
  INSERT INTO public.spray_exposure_invalidations (kind, key, observed_at)
  VALUES (dependency, source_key, clock_timestamp());
END;
$body$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.spray_exposure_invalidate(text, text, text) FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION public.spray_exposure_board_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $body$
DECLARE
  old_key text;
  new_key text;
BEGIN
  IF TG_OP <> 'INSERT' AND OLD.board_type = 'spray' THEN old_key := OLD.uuid; END IF;
  IF TG_OP <> 'DELETE' AND NEW.board_type = 'spray' THEN new_key := NEW.uuid; END IF;
  IF old_key IS NOT NULL THEN PERFORM public.spray_exposure_invalidate('board', old_key, NULL); END IF;
  IF new_key IS NOT NULL AND new_key IS DISTINCT FROM old_key THEN
    PERFORM public.spray_exposure_invalidate('board', new_key, NULL);
  END IF;
  RETURN NULL;
END;
$body$;
--> statement-breakpoint
CREATE FUNCTION public.spray_exposure_wall_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $body$
BEGIN
  IF TG_OP <> 'INSERT' THEN PERFORM public.spray_exposure_invalidate('wall', OLD.id::text, NULL); END IF;
  IF TG_OP <> 'DELETE' AND (TG_OP = 'INSERT' OR NEW.id <> OLD.id) THEN
    PERFORM public.spray_exposure_invalidate('wall', NEW.id::text, NULL);
  END IF;
  RETURN NULL;
END;
$body$;
--> statement-breakpoint
CREATE FUNCTION public.spray_exposure_version_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $body$
BEGIN
  IF TG_OP <> 'INSERT' THEN PERFORM public.spray_exposure_invalidate('version', OLD.id::text, NULL); END IF;
  IF TG_OP <> 'DELETE' AND (TG_OP = 'INSERT' OR NEW.id <> OLD.id) THEN
    PERFORM public.spray_exposure_invalidate('version', NEW.id::text, NULL);
  END IF;
  RETURN NULL;
END;
$body$;
--> statement-breakpoint
CREATE FUNCTION public.spray_exposure_policy_invalidate(board_uuid text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $body$
BEGIN
  -- Always fence the board UUID before classification. The base board trigger
  -- separately covers hard creates/deletes, type changes and re-keying.
  PERFORM pg_advisory_xact_lock_shared(public.spray_exposure_fence_key('board', board_uuid));
  IF EXISTS (SELECT 1 FROM public.user_boards WHERE uuid = board_uuid AND board_type = 'spray') THEN
    PERFORM public.spray_exposure_invalidate('policy', board_uuid, NULL);
  END IF;
END;
$body$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.spray_exposure_policy_invalidate(text) FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION public.spray_exposure_policy_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $body$
DECLARE
  old_key text;
  new_key text;
BEGIN
  IF TG_OP <> 'INSERT' AND OLD.kind = 'board' AND OLD.audience = 'only_me' THEN old_key := OLD.resource_id; END IF;
  IF TG_OP <> 'DELETE' AND NEW.kind = 'board' AND NEW.audience = 'only_me' THEN new_key := NEW.resource_id; END IF;
  IF old_key IS DISTINCT FROM new_key THEN
    IF old_key IS NOT NULL THEN PERFORM public.spray_exposure_policy_invalidate(old_key); END IF;
    IF new_key IS NOT NULL THEN PERFORM public.spray_exposure_policy_invalidate(new_key); END IF;
  END IF;
  RETURN NULL;
END;
$body$;
--> statement-breakpoint
CREATE FUNCTION public.spray_exposure_climb_key(layout_id integer, climb_uuid text) RETURNS text
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE SET search_path = pg_catalog
AS $key$
  SELECT layout_id::text || ':' || climb_uuid
$key$;
--> statement-breakpoint
CREATE FUNCTION public.spray_exposure_climb_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $body$
DECLARE
  old_key text;
  new_key text;
BEGIN
  IF TG_OP <> 'INSERT' AND OLD.board_type = 'spray' AND OLD.is_draft IS NOT TRUE
    AND OLD.is_listed IS TRUE AND NOT OLD.is_hidden AND nullif(OLD.frames, '') IS NOT NULL
    AND coalesce(OLD.missing_hold_count, 0) = 0 AND NOT coalesce(OLD.retired_by_reset, false)
  THEN old_key := public.spray_exposure_climb_key(OLD.layout_id, OLD.uuid); END IF;
  IF TG_OP <> 'DELETE' AND NEW.board_type = 'spray' AND NEW.is_draft IS NOT TRUE
    AND NEW.is_listed IS TRUE AND NOT NEW.is_hidden AND nullif(NEW.frames, '') IS NOT NULL
    AND coalesce(NEW.missing_hold_count, 0) = 0 AND NOT coalesce(NEW.retired_by_reset, false)
  THEN new_key := public.spray_exposure_climb_key(NEW.layout_id, NEW.uuid); END IF;

  IF old_key IS DISTINCT FROM new_key THEN
    IF old_key IS NOT NULL THEN PERFORM public.spray_exposure_invalidate('layout', old_key, OLD.layout_id::text); END IF;
    IF new_key IS NOT NULL THEN PERFORM public.spray_exposure_invalidate('layout', new_key, NEW.layout_id::text); END IF;
  END IF;
  RETURN NULL;
END;
$body$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.spray_exposure_board_change() FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.spray_exposure_wall_change() FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.spray_exposure_version_change() FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.spray_exposure_policy_change() FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.spray_exposure_climb_change() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER spray_exposure_board_insert AFTER INSERT ON public.user_boards
FOR EACH ROW WHEN (NEW.board_type = 'spray') EXECUTE FUNCTION public.spray_exposure_board_change();
--> statement-breakpoint
CREATE TRIGGER spray_exposure_board_delete AFTER DELETE ON public.user_boards
FOR EACH ROW WHEN (OLD.board_type = 'spray') EXECUTE FUNCTION public.spray_exposure_board_change();
--> statement-breakpoint
CREATE TRIGGER spray_exposure_board_update AFTER UPDATE OF id, uuid, board_type, layout_id, angle, gym_id, deleted_at, merged_into_board_uuid
ON public.user_boards FOR EACH ROW WHEN (
  (OLD.board_type = 'spray' OR NEW.board_type = 'spray')
  AND (OLD.id, OLD.uuid, OLD.board_type, OLD.layout_id, OLD.angle, OLD.gym_id, OLD.deleted_at IS NULL, OLD.merged_into_board_uuid IS NULL)
    IS DISTINCT FROM
      (NEW.id, NEW.uuid, NEW.board_type, NEW.layout_id, NEW.angle, NEW.gym_id, NEW.deleted_at IS NULL, NEW.merged_into_board_uuid IS NULL)
) EXECUTE FUNCTION public.spray_exposure_board_change();
--> statement-breakpoint
CREATE TRIGGER spray_exposure_wall_lifecycle AFTER INSERT OR DELETE ON public.spray_walls
FOR EACH ROW EXECUTE FUNCTION public.spray_exposure_wall_change();
--> statement-breakpoint
CREATE TRIGGER spray_exposure_wall_update AFTER UPDATE OF id, board_uuid, layout_id, current_version_id, deleted_at, archived_at, hidden_at
ON public.spray_walls FOR EACH ROW WHEN (
  (OLD.id, OLD.board_uuid, OLD.layout_id, OLD.current_version_id, OLD.deleted_at IS NULL, OLD.archived_at IS NULL, OLD.hidden_at IS NULL)
    IS DISTINCT FROM
  (NEW.id, NEW.board_uuid, NEW.layout_id, NEW.current_version_id, NEW.deleted_at IS NULL, NEW.archived_at IS NULL, NEW.hidden_at IS NULL)
) EXECUTE FUNCTION public.spray_exposure_wall_change();
--> statement-breakpoint
CREATE TRIGGER spray_exposure_version_lifecycle AFTER INSERT OR DELETE ON public.spray_wall_versions
FOR EACH ROW EXECUTE FUNCTION public.spray_exposure_version_change();
--> statement-breakpoint
CREATE TRIGGER spray_exposure_version_update AFTER UPDATE OF id, wall_id, status ON public.spray_wall_versions
FOR EACH ROW WHEN ((OLD.id, OLD.wall_id, OLD.status = 'published') IS DISTINCT FROM
                    (NEW.id, NEW.wall_id, NEW.status = 'published'))
EXECUTE FUNCTION public.spray_exposure_version_change();
--> statement-breakpoint
CREATE TRIGGER spray_exposure_policy_lifecycle AFTER INSERT OR DELETE ON public.resource_privacy
FOR EACH ROW EXECUTE FUNCTION public.spray_exposure_policy_change();
--> statement-breakpoint
CREATE TRIGGER spray_exposure_policy_update AFTER UPDATE OF kind, resource_id, audience ON public.resource_privacy
FOR EACH ROW EXECUTE FUNCTION public.spray_exposure_policy_change();
--> statement-breakpoint
CREATE TRIGGER spray_exposure_climb_insert AFTER INSERT ON public.board_climbs
FOR EACH ROW WHEN (NEW.board_type = 'spray') EXECUTE FUNCTION public.spray_exposure_climb_change();
--> statement-breakpoint
CREATE TRIGGER spray_exposure_climb_delete AFTER DELETE ON public.board_climbs
FOR EACH ROW WHEN (OLD.board_type = 'spray') EXECUTE FUNCTION public.spray_exposure_climb_change();
--> statement-breakpoint
CREATE TRIGGER spray_exposure_climb_update AFTER UPDATE OF board_type, layout_id, uuid, is_draft, is_listed, is_hidden,
  frames, missing_hold_count, retired_by_reset ON public.board_climbs
FOR EACH ROW WHEN (OLD.board_type = 'spray' OR NEW.board_type = 'spray')
EXECUTE FUNCTION public.spray_exposure_climb_change();
--> statement-breakpoint
RESET lock_timeout;
