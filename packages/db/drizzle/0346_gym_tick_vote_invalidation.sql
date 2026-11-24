SET LOCAL lock_timeout = '3s';
--> statement-breakpoint
CREATE FUNCTION public.invalidate_gym_tick_votes() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $invalidate_gym_tick_votes$
BEGIN
  IF ROW(
    OLD.id, OLD.uuid, OLD.user_id, OLD.origin, OLD.board_id, OLD.reporting_board_id,
    OLD.reporting_gym_id, coalesce(OLD.reporting_attribution IN ('uuid', 'presence', 'session', 'edit'), false),
    OLD.board_type, OLD.climb_uuid, OLD.angle, OLD.is_mirror, OLD.climbed_at,
    OLD.reporting_climbed_at, OLD.reporting_time_precision, OLD.reporting_date, OLD.reporting_date_time_zone
  ) IS DISTINCT FROM ROW(
    NEW.id, NEW.uuid, NEW.user_id, NEW.origin, NEW.board_id, NEW.reporting_board_id,
    NEW.reporting_gym_id, coalesce(NEW.reporting_attribution IN ('uuid', 'presence', 'session', 'edit'), false),
    NEW.board_type, NEW.climb_uuid, NEW.angle, NEW.is_mirror, NEW.climbed_at,
    NEW.reporting_climbed_at, NEW.reporting_time_precision, NEW.reporting_date, NEW.reporting_date_time_zone
  ) THEN
    DELETE FROM public.gym_reporting_tick_votes WHERE tick_id = OLD.id;
  ELSIF OLD.quality IS DISTINCT FROM NEW.quality OR OLD.difficulty IS DISTINCT FROM NEW.difficulty THEN
    DELETE FROM public.gym_reporting_tick_votes WHERE tick_id = OLD.id AND (
      (metric = 'QUALITY' AND OLD.quality IS DISTINCT FROM NEW.quality)
      OR (metric = 'DIFFICULTY' AND OLD.difficulty IS DISTINCT FROM NEW.difficulty)
    );
  END IF;
  RETURN NULL;
END;
$invalidate_gym_tick_votes$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.invalidate_gym_tick_votes() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER trg_invalidate_gym_tick_votes
AFTER UPDATE OF id, uuid, user_id, origin, board_id, reporting_board_id, reporting_gym_id,
  reporting_attribution, board_type, climb_uuid, angle, is_mirror, climbed_at, reporting_climbed_at,
  reporting_time_precision, reporting_date, reporting_date_time_zone, quality, difficulty
ON public.boardsesh_ticks
FOR EACH ROW EXECUTE FUNCTION public.invalidate_gym_tick_votes();
