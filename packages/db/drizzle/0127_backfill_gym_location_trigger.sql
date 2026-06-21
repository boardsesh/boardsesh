-- Custom SQL migration file, put your code below! --

-- The PostGIS `location` geography on gyms / user_boards is derived from the
-- latitude/longitude columns, but it lives outside the Drizzle schema and has
-- only ever been kept in sync by callers remembering to run a separate
-- `UPDATE ... SET location = ST_MakePoint(...)`. Boards got a one-time backfill
-- in 0052; gyms never did (0054 added the column + GIST index but no backfill),
-- so ~2,800 gyms imported before the location-sync fix have lat/lng but a NULL
-- geography and are invisible to proximity search (which filters
-- `location IS NOT NULL`).
--
-- This migration makes the derivation a database invariant instead of a caller
-- responsibility: a BEFORE INSERT/UPDATE trigger recomputes `location` from
-- lat/lng on both tables, so no importer, seed, or manual write can leave it
-- stale again. Plain plpgsql + PostGIS — runs on stock postgres:17, no
-- Railway-specific features.

CREATE OR REPLACE FUNCTION set_location_from_coordinates() RETURNS trigger AS $$
BEGIN
  IF NEW.latitude IS NOT NULL AND NEW.longitude IS NOT NULL THEN
    NEW.location := ST_MakePoint(NEW.longitude, NEW.latitude)::geography;
  ELSE
    NEW.location := NULL;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

-- Fire only when the source coordinates are part of the write, so name-only
-- updates don't pay for a geography recompute. CREATE OR REPLACE (Postgres 14+,
-- safe on postgres:17) keeps the statement idempotent alongside the function.
CREATE OR REPLACE TRIGGER gyms_set_location
  BEFORE INSERT OR UPDATE OF latitude, longitude ON gyms
  FOR EACH ROW EXECUTE FUNCTION set_location_from_coordinates();
--> statement-breakpoint

CREATE OR REPLACE TRIGGER user_boards_set_location
  BEFORE INSERT OR UPDATE OF latitude, longitude ON user_boards
  FOR EACH ROW EXECUTE FUNCTION set_location_from_coordinates();
--> statement-breakpoint

-- Backfill the gyms stranded before the trigger existed.
UPDATE gyms
  SET location = ST_MakePoint(longitude, latitude)::geography
  WHERE latitude IS NOT NULL AND longitude IS NOT NULL AND location IS NULL;
--> statement-breakpoint

-- Boards were backfilled by 0052; this covers any that slipped through since.
UPDATE user_boards
  SET location = ST_MakePoint(longitude, latitude)::geography
  WHERE latitude IS NOT NULL AND longitude IS NOT NULL AND location IS NULL;
