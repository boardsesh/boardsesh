ALTER TABLE "qa_verdicts" ADD COLUMN "by_tester" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- Backfill: every pre-existing row was filed while submitQaVerdict still called
-- requireTester, so all of them ARE tester verdicts. Without this the DEFAULT
-- marks them non-tester, and the label recompute (which reads by_tester = true)
-- finds nothing on any PR whose only verdicts predate this migration — freezing
-- its qa-approved/qa-declined label until a tester files again.
--
-- In the same migration as the ADD COLUMN on purpose: split across two, a
-- database that applied only the first would read every historical verdict as
-- non-tester.
UPDATE "qa_verdicts" SET "by_tester" = true;
