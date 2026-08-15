-- Keep board_climb_stats' offline cursor tied to the exact payload shipped by
-- syncClimbStats. Migration 0146 compared OLD.* with NEW.*, but
-- upstream_synced_at was added later as manufacturer-sync provenance. Every
-- catalog pass legitimately refreshes that timestamp, so the broad comparison
-- advanced updated_at/sync_seq for otherwise identical rows and made clients
-- page the whole stats table after importing a CDN snapshot.
--
-- Use an explicit allowlist instead of subtracting today's internal columns.
-- board_climb_stats has several server-only aggregate components and may gain
-- more provenance columns; none should invalidate device cursors unless their
-- materialized, client-visible result changes. Keep this tuple in lockstep with
-- syncClimbStats' selectList and TABLE_CONFIGS.board_climb_stats.localColumns
-- (excluding the two cursor fields themselves).
DROP TRIGGER IF EXISTS trg_board_climb_stats_set_sync_fields ON "board_climb_stats";
--> statement-breakpoint
CREATE TRIGGER trg_board_climb_stats_set_sync_fields BEFORE UPDATE ON "board_climb_stats"
  FOR EACH ROW
  WHEN (ROW(
          OLD.board_type,
          OLD.climb_uuid,
          OLD.angle,
          OLD.display_difficulty,
          OLD.benchmark_difficulty,
          OLD.ascensionist_count,
          OLD.difficulty_average,
          OLD.quality_average,
          OLD.fa_username,
          OLD.fa_at
        ) IS DISTINCT FROM ROW(
          NEW.board_type,
          NEW.climb_uuid,
          NEW.angle,
          NEW.display_difficulty,
          NEW.benchmark_difficulty,
          NEW.ascensionist_count,
          NEW.difficulty_average,
          NEW.quality_average,
          NEW.fa_username,
          NEW.fa_at
        ))
  EXECUTE FUNCTION set_board_climb_stats_sync_fields();
