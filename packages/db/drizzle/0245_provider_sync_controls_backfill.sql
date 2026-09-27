-- One control row per existing credential, so the first job queued against an
-- account linked before this release finds a generation to fence on. Every
-- credential row is a live link (an unlink deletes the row), so linked = true.
-- ON CONFLICT keeps a re-run, or a row a relink already created, untouched.
INSERT INTO "provider_sync_controls" ("user_id", "board_type", "linked")
SELECT "user_id", "board_type", true
FROM "aurora_credentials"
ON CONFLICT ("user_id", "board_type") DO NOTHING;
