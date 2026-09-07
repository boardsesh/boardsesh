-- Custom SQL migration file, put your code below! --
--
-- Issue #5127. Sibling of 0135, which promoted Aurora's LEADING "No match"
-- description prefix into board_climbs.characteristics. Aurora has no rules
-- field at all, and setters commonly APPEND the declaration after their own
-- prose instead ("Kick board is off. No matching."), which 0135's
-- `LIKE 'no match%'` never saw. Those climbs carry the rule in the notes but
-- show no no-match glyph — 1,120 on the TB2 Spray (tension layout 11) alone.
--
-- The predicate is the exact SQL twin of the widened isNoMatchClimb()
-- (packages/shared-schema/src/utils.ts): 0135's leading LIKE OR the trailing
-- pattern exported there as NO_MATCH_TRAILING_SQL_PATTERN. Verified against all
-- 173,016 catalog descriptions mentioning "match": zero disagreements between
-- the two engines. Running BOTH halves also repairs 480 leading-match strays
-- 0135 itself missed (tension 432, kilter 48) at no extra cost.
--
-- The trailing half requires the declaration to OPEN a sentence, which is what
-- keeps "You can match start hold but the rest is no matching", "Campus, no
-- match" and "(no match)" out. ~2.2k rows that end with the phrase after a bare
-- space or comma stay untagged on purpose: a wrong glyph is worse than a
-- missing one.
--
-- Measured on the dev catalog (same rows as prod), 2026-09-07 — 14,906 rows:
--   tension 8,289 · kilter 6,324 · grasshopper 111 · decoy 100 · soill 71
--   · touchstone 11.  moonboard 0, woods 0.
--
-- `user_id IS NULL`: never override a rule a Boardsesh author saved. An empty
-- `characteristics` array is the explicit-false sentinel updateClimb writes when
-- a user turns the toggle off on a climb whose prose still declares it, and
-- climbCharacteristicsConflictSql protects it from the sync. 0 of the 14,906
-- candidates are user rows today — the clause is here so this statement can
-- never break that contract.
--
-- `board_type` fence mirrors usesAuroraNoMatchDescription(): on MoonBoard a
-- description mentioning no-match is user prose, and on Woods a NULL
-- characteristics means "rules unknown until the catalog repair". 0 rows either
-- way today; it also excludes 2 MoonBoard leading-match strays.
--
-- Idempotent: the `NOT (... @> ARRAY['no_match'])` guard makes a re-run a no-op,
-- so no _bs_migration_guards row is needed (same as 0135). Cost: a ~285 ms
-- parallel seq scan plus ~14.9k row writes, each firing
-- trg_board_climbs_set_sync_fields — so the fix reaches downloaded boards as a
-- bounded one-time ~15k-row incremental re-pull.
UPDATE board_climbs
   SET characteristics = array_append(COALESCE(characteristics, '{}'), 'no_match')
 WHERE user_id IS NULL
   AND board_type NOT IN ('moonboard', 'woods')
   AND (
     LOWER(COALESCE(description, '')) LIKE 'no match%'
     OR description ~* '(^|[\n.!?;)\]]|[[:space:]]-)[[:space:]]*no[[:space:]-]?match(ing|es)?[.!?;,[:space:]]*$'
   )
   AND NOT (COALESCE(characteristics, '{}') @> ARRAY['no_match']);
