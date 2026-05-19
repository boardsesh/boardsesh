-- Migration: Backfill board_sessions.shared_playlist_enabled for live sessions.
--
-- Context:
--   Migration 0101 introduces the per-board history WebSocket room model and
--   makes the shared-playlist queue an opt-in feature. The new column defaults
--   to false so newly-created sessions land in the simpler local-queue mode.
--
--   Without this backfill, every session that was already live at the cutover
--   would silently flip from shared-queue to local-only — every member would
--   see their queue empty out and lose the shared state they were collaborating
--   on. We preserve continuity by flipping shared_playlist_enabled = true for
--   any session that has not yet ended.
--
-- What this does:
--   For every board_sessions row where ended_at IS NULL, set
--   shared_playlist_enabled = true. Sessions whose lifecycle has already ended
--   stay at the new default — they don't matter going forward.
--
-- Safety / idempotency:
--   - Idempotent: re-running is a no-op (the WHERE NOT predicate guards repeats).
--   - Touches only rows the user can still see in their drawer.
--   - No data deleted; no FKs changed.

UPDATE board_sessions
   SET shared_playlist_enabled = true
 WHERE ended_at IS NULL
   AND shared_playlist_enabled = false;
