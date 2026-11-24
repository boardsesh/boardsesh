-- A physical-wall verification covers one uninterrupted venue association.
-- Defer the check until commit so a duplicate-gym consolidation can repoint
-- boards before it stamps the old gym's canonical pointer in the same transaction.
CREATE FUNCTION public.revoke_gym_reporting_aliases_on_board_move()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $revoke_gym_reporting_aliases$
BEGIN
  IF OLD.gym_id IS NOT DISTINCT FROM NEW.gym_id THEN
    RETURN NEW;
  END IF;
  IF OLD.gym_id IS NOT NULL AND NEW.gym_id IS NOT NULL AND EXISTS (
    WITH RECURSIVE venue_chain AS (
      SELECT venue.id, venue.merged_into_gym_id, venue.deleted_at, ARRAY[venue.id] AS visited
      FROM public.gyms venue WHERE venue.id = OLD.gym_id
      UNION ALL
      SELECT parent.id, parent.merged_into_gym_id, parent.deleted_at, venue_chain.visited || parent.id
      FROM venue_chain JOIN public.gyms parent ON parent.id = venue_chain.merged_into_gym_id
      WHERE venue_chain.deleted_at IS NOT NULL
        AND NOT parent.id = ANY(venue_chain.visited)
        AND cardinality(venue_chain.visited) < 10
    )
    SELECT 1 FROM venue_chain WHERE id = NEW.gym_id AND deleted_at IS NULL
  ) THEN
    RETURN NEW;
  END IF;

  -- The moving writer still holds the board row lock. A verification must lock
  -- both endpoints before it can insert, so it cannot race past this revocation.
  UPDATE public.gym_reporting_board_aliases
     SET revoked_at = clock_timestamp()
   WHERE revoked_at IS NULL AND (board_id = NEW.id OR root_board_id = NEW.id);
  RETURN NEW;
END
$revoke_gym_reporting_aliases$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.revoke_gym_reporting_aliases_on_board_move() FROM PUBLIC;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER trg_gym_reporting_aliases_board_move
AFTER UPDATE OF gym_id ON public.user_boards
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (OLD.gym_id IS DISTINCT FROM NEW.gym_id)
EXECUTE FUNCTION public.revoke_gym_reporting_aliases_on_board_move();
