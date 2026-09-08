ALTER TABLE "board_sessions" ADD CONSTRAINT "board_sessions_explicit_board_path_check" CHECK ("board_sessions"."origin" <> 'explicit' OR "board_sessions"."board_path" IS NOT NULL);
