-- Every session export change commits with the write that produced it. The
-- companion log shares the tick sequence without changing old readers' table.
-- Locks are catalog-only; acquire the complete writer closure together and
-- back off rather than making board writes queue behind a long migration.
DO $session_sync_locks$
DECLARE attempts integer := 0;
BEGIN
  LOOP
    attempts := attempts + 1;
    BEGIN
      SET LOCAL lock_timeout = '1s';
      LOCK TABLE public.board_sessions, public.boardsesh_ticks,
        public.board_session_participants, public.session_workouts, public.app_workouts, public.board_climb_aliases
        IN SHARE ROW EXCLUSIVE MODE;
      SET LOCAL lock_timeout = '0';
      RETURN;
    EXCEPTION WHEN lock_not_available OR deadlock_detected THEN
      IF attempts >= 60 THEN RAISE; END IF;
      PERFORM pg_sleep(1);
    END;
  END LOOP;
END $session_sync_locks$;
--> statement-breakpoint

-- Enable a fresh consent request for existing managed registrations. This is
-- allowed registration scope only: no token, consent, grant or connection is widened.
UPDATE public.oauth_client AS client
SET scopes = array_append(client.scopes, 'sessions:read')
WHERE client.scopes IS NOT NULL AND NOT ('sessions:read' = ANY(client.scopes))
  AND EXISTS (SELECT 1 FROM public.oauth_app_policy policy WHERE policy.client_id = client.client_id);
--> statement-breakpoint
UPDATE public.oauth_resource AS resource
SET allowed_scopes = array_append(resource.allowed_scopes, 'sessions:read')
WHERE resource.identifier = 'https://api.boardsesh.com/v1'
  AND resource.allowed_scopes IS NOT NULL AND NOT ('sessions:read' = ANY(resource.allowed_scopes));
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.log_partner_session_from_session() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog
AS $partner_session_row$
DECLARE
  target_session_id text;
  export_id uuid;
  previous_owner text;
  next_owner text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'ended' OR NEW.is_permanent THEN RETURN NEW; END IF;
    target_session_id := NEW.id; export_id := NEW.export_id; next_owner := NEW.created_by_user_id;
  ELSE
    IF TG_OP = 'UPDATE' AND OLD.status <> 'ended' AND NEW.status <> 'ended' THEN RETURN NEW; END IF;
    IF TG_OP = 'DELETE' AND (OLD.status <> 'ended' OR OLD.is_permanent) THEN RETURN OLD; END IF;
    IF TG_OP = 'UPDATE' AND OLD.is_permanent AND NEW.is_permanent THEN RETURN NEW; END IF;
    target_session_id := OLD.id; export_id := OLD.export_id; previous_owner := OLD.created_by_user_id;
    IF TG_OP = 'UPDATE' THEN next_owner := NEW.created_by_user_id; END IF;
  END IF;
  INSERT INTO public.logbook_session_changes (user_id, session_export_id, remove_if_missing)
    SELECT recipients.user_id, export_id, true FROM (
      SELECT previous_owner AS user_id UNION SELECT next_owner
      UNION SELECT participant.user_id FROM public.board_session_participants participant WHERE participant.session_id = target_session_id
    ) recipients WHERE recipients.user_id IS NOT NULL;
  -- Completing/reopening, changing eligibility, or deleting a session changes
  -- the nullable session reference carried by its own ticks too.
  IF TG_OP = 'DELETE' OR (TG_OP = 'UPDATE' AND (
    OLD.status IS DISTINCT FROM NEW.status OR OLD.is_permanent IS DISTINCT FROM NEW.is_permanent
    OR OLD.created_by_user_id IS DISTINCT FROM NEW.created_by_user_id
  )) THEN
    INSERT INTO public.logbook_changes (user_id, tick_uuid)
      SELECT tick.user_id, tick.uuid FROM public.boardsesh_ticks tick WHERE tick.session_id = target_session_id;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $partner_session_row$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.log_partner_session_from_session() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER trg_partner_session_insert AFTER INSERT ON public.board_sessions
  FOR EACH ROW EXECUTE FUNCTION public.log_partner_session_from_session();
--> statement-breakpoint
CREATE TRIGGER trg_partner_session_update BEFORE UPDATE ON public.board_sessions
  FOR EACH ROW WHEN (
    OLD.name IS DISTINCT FROM NEW.name OR OLD.goal IS DISTINCT FROM NEW.goal
    OR OLD.notes IS DISTINCT FROM NEW.notes OR OLD.started_at IS DISTINCT FROM NEW.started_at
    OR OLD.ended_at IS DISTINCT FROM NEW.ended_at OR OLD.status IS DISTINCT FROM NEW.status
    OR OLD.is_permanent IS DISTINCT FROM NEW.is_permanent OR OLD.timezone IS DISTINCT FROM NEW.timezone
    OR OLD.created_by_user_id IS DISTINCT FROM NEW.created_by_user_id OR OLD.board_id IS DISTINCT FROM NEW.board_id
    OR OLD.board_path IS DISTINCT FROM NEW.board_path OR OLD.origin IS DISTINCT FROM NEW.origin
  ) EXECUTE FUNCTION public.log_partner_session_from_session();
--> statement-breakpoint
CREATE TRIGGER trg_partner_session_delete BEFORE DELETE ON public.board_sessions
  FOR EACH ROW EXECUTE FUNCTION public.log_partner_session_from_session();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.log_partner_session_from_participant() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog
AS $partner_session_participant$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    INSERT INTO public.logbook_session_changes (user_id, session_export_id, remove_if_missing)
      SELECT OLD.user_id, session.export_id, true FROM public.board_sessions session WHERE session.id = OLD.session_id;
    INSERT INTO public.logbook_changes (user_id, tick_uuid)
      SELECT tick.user_id, tick.uuid FROM public.boardsesh_ticks tick WHERE tick.user_id = OLD.user_id AND tick.session_id = OLD.session_id;
  END IF;
  IF TG_OP <> 'DELETE' THEN
    INSERT INTO public.logbook_session_changes (user_id, session_export_id, remove_if_missing)
      SELECT NEW.user_id, session.export_id, true FROM public.board_sessions session WHERE session.id = NEW.session_id;
    INSERT INTO public.logbook_changes (user_id, tick_uuid)
      SELECT tick.user_id, tick.uuid FROM public.boardsesh_ticks tick WHERE tick.user_id = NEW.user_id AND tick.session_id = NEW.session_id;
  END IF;
  RETURN NULL;
END $partner_session_participant$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.log_partner_session_from_participant() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER trg_partner_session_participant AFTER INSERT OR UPDATE OR DELETE ON public.board_session_participants
  FOR EACH ROW EXECUTE FUNCTION public.log_partner_session_from_participant();
--> statement-breakpoint

-- Log changes even while active/permanent: a concurrent completion can be
-- uncommitted in this writer's snapshot. The shared transaction horizon keeps
-- that hint from being delivered past the in-flight completion. Eligibility is
-- checked at delivery, so an active/permanent session exposes no session data.
-- Both workout tables have (session_id,user_id). No other climber's workout is
-- exposed: its owner's own session projection is the only affected recipient.
CREATE OR REPLACE FUNCTION public.log_partner_session_from_workout() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog
AS $partner_session_workout$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    INSERT INTO public.logbook_session_changes (user_id, session_export_id)
      SELECT OLD.user_id, session.export_id FROM public.board_sessions session
      WHERE session.id = OLD.session_id;
  END IF;
  IF TG_OP <> 'DELETE' THEN
    INSERT INTO public.logbook_session_changes (user_id, session_export_id)
      SELECT NEW.user_id, session.export_id FROM public.board_sessions session
      WHERE session.id = NEW.session_id;
  END IF;
  RETURN NULL;
END $partner_session_workout$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.log_partner_session_from_workout() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER trg_partner_session_workout AFTER INSERT OR UPDATE OR DELETE ON public.session_workouts
  FOR EACH ROW EXECUTE FUNCTION public.log_partner_session_from_workout();
--> statement-breakpoint
CREATE TRIGGER trg_partner_session_app_workout AFTER INSERT OR UPDATE OR DELETE ON public.app_workouts
  FOR EACH ROW EXECUTE FUNCTION public.log_partner_session_from_workout();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.log_partner_session_from_tick() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog
AS $partner_session_tick$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    INSERT INTO public.logbook_session_changes (user_id, session_export_id)
      SELECT OLD.user_id, session.export_id FROM public.board_sessions session
      WHERE session.id = OLD.session_id;
  END IF;
  IF TG_OP <> 'DELETE' THEN
    INSERT INTO public.logbook_session_changes (user_id, session_export_id)
      SELECT NEW.user_id, session.export_id FROM public.board_sessions session
      WHERE session.id = NEW.session_id;
  END IF;
  -- A natural-key mutation may hide/reveal an Aurora twin that belongs to a
  -- different session. Its derived workout results must be invalidated too.
  IF TG_OP <> 'INSERT' AND OLD.origin = 'aurora_pull' AND OLD.aurora_id IS NOT NULL
    AND OLD.aurora_id NOT LIKE 'json-import-%' THEN
    INSERT INTO public.logbook_session_changes (user_id, session_export_id)
      SELECT DISTINCT twin.user_id, session.export_id FROM public.boardsesh_ticks twin
      JOIN public.board_sessions session ON session.id = twin.session_id
      WHERE twin.user_id = OLD.user_id AND twin.climbed_at = OLD.climbed_at
        AND twin.board_type = OLD.board_type AND twin.climb_uuid = OLD.climb_uuid AND twin.angle = OLD.angle
        AND twin.origin = 'aurora_pull' AND twin.aurora_id IS NOT NULL AND twin.aurora_id NOT LIKE 'json-import-%'
        AND twin.uuid <> OLD.uuid;
  END IF;
  IF TG_OP <> 'DELETE' AND NEW.origin = 'aurora_pull' AND NEW.aurora_id IS NOT NULL
    AND NEW.aurora_id NOT LIKE 'json-import-%' THEN
    INSERT INTO public.logbook_session_changes (user_id, session_export_id)
      SELECT DISTINCT twin.user_id, session.export_id FROM public.boardsesh_ticks twin
      JOIN public.board_sessions session ON session.id = twin.session_id
      WHERE twin.user_id = NEW.user_id AND twin.climbed_at = NEW.climbed_at
        AND twin.board_type = NEW.board_type AND twin.climb_uuid = NEW.climb_uuid AND twin.angle = NEW.angle
        AND twin.origin = 'aurora_pull' AND twin.aurora_id IS NOT NULL AND twin.aurora_id NOT LIKE 'json-import-%'
        AND twin.uuid <> NEW.uuid;
  END IF;
  RETURN NULL;
END $partner_session_tick$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.log_partner_session_from_tick() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER trg_partner_session_tick_insert_delete AFTER INSERT OR DELETE ON public.boardsesh_ticks
  FOR EACH ROW EXECUTE FUNCTION public.log_partner_session_from_tick();
--> statement-breakpoint
CREATE TRIGGER trg_partner_session_tick_update AFTER UPDATE ON public.boardsesh_ticks
  FOR EACH ROW WHEN (
    OLD.user_id IS DISTINCT FROM NEW.user_id OR OLD.session_id IS DISTINCT FROM NEW.session_id
    OR OLD.uuid IS DISTINCT FROM NEW.uuid OR OLD.climb_uuid IS DISTINCT FROM NEW.climb_uuid
    OR OLD.angle IS DISTINCT FROM NEW.angle OR OLD.is_mirror IS DISTINCT FROM NEW.is_mirror
    OR OLD.status IS DISTINCT FROM NEW.status OR OLD.attempt_count IS DISTINCT FROM NEW.attempt_count
    OR OLD.climbed_at IS DISTINCT FROM NEW.climbed_at OR OLD.updated_at IS DISTINCT FROM NEW.updated_at
    OR OLD.origin IS DISTINCT FROM NEW.origin OR OLD.aurora_id IS DISTINCT FROM NEW.aurora_id
    OR OLD.aurora_synced_at IS DISTINCT FROM NEW.aurora_synced_at OR OLD.kilter_id IS DISTINCT FROM NEW.kilter_id
  ) EXECUTE FUNCTION public.log_partner_session_from_tick();

--> statement-breakpoint
-- True catalog merges are rare and already guarded against daily self-alias
-- refreshes. JSON containment also finds skipped plan items without tick rows;
-- this infrequent fan-out deliberately adds no broad write-time GIN indexes.
CREATE OR REPLACE FUNCTION public.log_partner_session_from_alias() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog
AS $partner_session_alias$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    INSERT INTO public.logbook_session_changes (user_id, session_export_id)
      SELECT DISTINCT tick.user_id, session.export_id FROM public.boardsesh_ticks tick
      JOIN public.board_sessions session ON session.id = tick.session_id
      WHERE tick.board_type = OLD.board_type AND tick.climb_uuid = OLD.alias_uuid;
  END IF;
  IF TG_OP <> 'DELETE' THEN
    INSERT INTO public.logbook_session_changes (user_id, session_export_id)
      SELECT DISTINCT tick.user_id, session.export_id FROM public.boardsesh_ticks tick
      JOIN public.board_sessions session ON session.id = tick.session_id
      WHERE tick.board_type = NEW.board_type AND tick.climb_uuid = NEW.alias_uuid;
  END IF;
  IF TG_OP <> 'INSERT' THEN
    INSERT INTO public.logbook_session_changes (user_id, session_export_id)
      SELECT workout.user_id, session.export_id FROM public.session_workouts workout
      JOIN public.board_sessions session ON session.id = workout.session_id
      WHERE workout.plan OPERATOR(pg_catalog.@>) pg_catalog.jsonb_build_object('stages', pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object('items', pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('climbUuid', OLD.alias_uuid)))));
    INSERT INTO public.logbook_session_changes (user_id, session_export_id)
      SELECT workout.user_id, session.export_id FROM public.app_workouts workout
      JOIN public.board_sessions session ON session.id = workout.session_id
      WHERE workout.plan_snapshot OPERATOR(pg_catalog.@>) pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object('climbUuids', pg_catalog.jsonb_build_array(OLD.alias_uuid)));
  END IF;
  IF TG_OP <> 'DELETE' THEN
    INSERT INTO public.logbook_session_changes (user_id, session_export_id)
      SELECT workout.user_id, session.export_id FROM public.session_workouts workout
      JOIN public.board_sessions session ON session.id = workout.session_id
      WHERE workout.plan OPERATOR(pg_catalog.@>) pg_catalog.jsonb_build_object('stages', pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object('items', pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('climbUuid', NEW.alias_uuid)))));
    INSERT INTO public.logbook_session_changes (user_id, session_export_id)
      SELECT workout.user_id, session.export_id FROM public.app_workouts workout
      JOIN public.board_sessions session ON session.id = workout.session_id
      WHERE workout.plan_snapshot OPERATOR(pg_catalog.@>) pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object('climbUuids', pg_catalog.jsonb_build_array(NEW.alias_uuid)));
  END IF;
  RETURN NULL;
END $partner_session_alias$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.log_partner_session_from_alias() FROM PUBLIC;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER trg_partner_session_alias_insert AFTER INSERT ON public.board_climb_aliases
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.alias_uuid <> NEW.canonical_uuid)
  EXECUTE FUNCTION public.log_partner_session_from_alias();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER trg_partner_session_alias_update AFTER UPDATE ON public.board_climb_aliases
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (OLD.canonical_uuid IS DISTINCT FROM NEW.canonical_uuid)
  EXECUTE FUNCTION public.log_partner_session_from_alias();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER trg_partner_session_alias_delete AFTER DELETE ON public.board_climb_aliases
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.log_partner_session_from_alias();
