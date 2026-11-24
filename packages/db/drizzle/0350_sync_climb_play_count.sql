-- Plays is now shipped by syncClimbStats. A changed count advances the cursor
-- through the existing function; an equal count still leaves it alone.
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
          OLD.play_count,
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
          NEW.play_count,
          NEW.difficulty_average,
          NEW.quality_average,
          NEW.fa_username,
          NEW.fa_at
        ))
  EXECUTE FUNCTION set_board_climb_stats_sync_fields();
