# Legacy mislabeled-UTC tick timestamps (#3909)

Some `boardsesh_ticks.climbed_at` values hold the climber's **local wall-clock
time relabelled as UTC**. A climber in Melbourne sees an evening session land on
the next calendar day; a climber in California sees it land on the previous one.
This is the runbook for measuring that, and for the correction that is **not yet
authorised to run**.

Nothing in this repo corrects a single row today. `vp run db:report-tick-timezones`
is read-only. `vp run db:backfill-tick-timezones` reports unless you pass
`--apply`, and refuses a non-local database without an extra environment
variable set by hand.

## Two mechanisms, three cohorts

The issue described one cause. There are two, and they behave differently.

**Mechanism A — server-local parse.** Pre-PR4 code did
`new Date("2024-01-15 10:30:00").toISOString()`, which V8 resolves in the
_server's_ zone. That produces ONE fleet-wide offset shared by every climber.
Commit `71937db6a` states it plainly for the live Aurora pull and for
`saveAscent`/`saveAttempt`. Whether it ever mattered in production is an open
question: no `TZ=` is set in any workflow or Dockerfile in this repo and
containers default to UTC, in which case the naive string was parsed as UTC
anyway and Mechanism A was a no-op. The report's mechanism probe tests that
rather than assuming it.

**Mechanism B — Aurora's naive string is the climber's local wall clock.** This
produces a PER-USER offset. It is what `tick-offset-inference.ts` documents, and
it is what #3909's measured distribution looks like (−1h×799, +8h×354, −10h×319,
+5h×153 — individual zones, not one deployment's). Mechanism B is **not** bounded
by the PR4 cutoff: if it is real, the live pull is still writing shifted rows
today.

| Cohort                          | Rows (#3909)   | Mechanism        |
| ------------------------------- | -------------- | ---------------- |
| `json_import`                   | 288,843        | B only           |
| `aurora_pull`                   | 58,479         | A (pre-PR4) + B  |
| `native` written by web pre-PR4 | part of 40,386 | A                |
| `kilter_pull`                   | 4,824          | neither — anchor |
| `native` post-PR4               | part of 40,386 | neither — anchor |

`json_import` never carried Mechanism A. The naive
`new Date(ts).toISOString()` does appear in `8fe79f60d`'s version of
`json-import.ts`, but that commit and its `Z`-fix `79185b916` both bottom out at
the same first merge — `e794401251817deb0758dc90ad768a7017f9eb50` (PR #936).
The naive variant never ran in production for a single import.

## What is honest, and how sure are we

Anchors are the rows we believe carry a true UTC instant:

- **post-cutoff `native`** — built from `getUTC*` accessors in
  `packages/backend/src/graphql/resolvers/ticks/mutations.ts`, honest by
  construction. The cutoff is `2026-07-10T09:43:23Z`: the merge instant of
  #3555 plus a 24-hour deploy buffer. Widen it if the deploy log says otherwise.
- **`kilter_pull`** — a PowerSync `created_at`, true UTC, but **not the same
  quantity**. `packages/kilter-sync/src/sync/user-sync.ts` stores
  `climbed_at = raw.created_at`, the instant the LOG ROW was created upstream;
  `RawLog` carries no `climbed_at` at all. For a back-dated log, suspect − anchor
  is the user's offset _plus_ the back-dating gap. So `kilter_pull` is the weaker
  anchor: a bucket with enough native keys ignores it entirely, and a
  kilter-only bucket must clear a tighter consistency bar.

The report's **anchor cross-check** compares the two honest families against
each other on ascents they share. If they do not concentrate at +00:00, the
correction direction is unproven and none of the rest of this document applies.

## Running the report

```
vp run db:report-tick-timezones
vp run db:report-tick-timezones -- --origin json_import,aurora_pull --out ./report.json
```

Read the sections in this order:

1. **(e) anchor cross-check.** Must concentrate at `+00:00`. If it does not,
   stop — the two families we call honest disagree with each other.
2. **(d) control cohort.** Each origin split around the PR4 deploy. A non-zero
   post-cutoff histogram means the writer is STILL producing shifted rows, and no
   correction may run until that is fixed — otherwise you correct history while
   new shifted rows keep arriving.
3. **(f) mechanism probe.** `usersWithMoreThanOneOffset` near zero with one
   dominant pooled spike points at Mechanism A (one deployment offset);
   a wide per-user spread points at Mechanism B.
4. **(g) verdicts.** Every abstain reason is enumerated. The residual line at
   the bottom is the number of rows that stay wrong by design.

The per-tick decision set goes to the `--out` JSON so a decision can be
re-reviewed without re-running.

## How a row is classified

Per `(user, board, calendar quarter)`, the median of the per-key
suspect↔anchor deltas becomes that bucket's offset. Quarters, not one offset per
climber: DST and travel move the offset, and flattening them produces a median
that fits neither half of the year. A neighbouring quarter is never borrowed.

Before any bucket offset is consulted, one per-row check runs:

> if this row already sits within 60s of an anchor on its OWN
> `(canonical climb, angle)`, it is **already correct** and is never touched.

That guard is the difference between a repair and a corruption.
`inferUserUtcOffsetSeconds` is explicitly built to survive a bucket of mixed
honest and shifted history — which means an already-correct row survives the
median and would then be shifted _by_ it. #3909 measured roughly 3% (62/2,128)
of suspect rows already aligned.

Abstain reasons, all counted in the report: `no-anchor`, `too-few-anchor-keys`
(fewer than 3 overlapping keys), `inconsistent-offset` (MAD over 60s, or over
30s for a kilter-only bucket), `offset-implausible` (over ±14h),
`profile-offset-zero`, `aurora-twin-member`.

Climb aliases are resolved on **both** sides before any of this. `kilter_pull`
writes canonical uuids; `json_import` and `aurora_pull` write whatever Aurora
sent. Joining raw `climb_uuid` silently drops every aliased climb.

## Before any `--apply` run

All of these, in order. None is optional.

1. The anchor cross-check comes back consistent.
2. **The writer guard is deployed.** `preserveCorrectedClimbedAt` in
   `packages/aurora-sync/src/sync/apply-user-logbook.ts` is what stops the pull
   rewriting the shifted value over a corrected row. Without it the correction
   self-reverts inside one sync cycle — a no-op that also churns every corrected
   row through offline sync.
3. Marco has answered the open questions below.
4. A `pg_dump` of `boardsesh_ticks`, or a confirmed PITR window covering the run.
5. A single-climber canary, verified in the app:
   `vp run db:backfill-tick-timezones -- --user <id> --apply`

Then, per cohort, off-peak, watching backend load:

```
TICK_TZ_BACKFILL_ALLOW_REMOTE=1 vp run db:backfill-tick-timezones -- --origin json_import --apply
```

Every write is one transaction per climber, guarded by
`WHERE climbed_at = <previous>` so a row edited since the decision is skipped
rather than clobbered, and each one inserts its undo into
`tick_climbed_at_corrections` in the same transaction.

To undo:

```
TICK_TZ_BACKFILL_ALLOW_REMOTE=1 vp run db:backfill-tick-timezones -- --revert <run-id> --apply
```

## Known consequences of a real run

- **Session-feed day boundaries move.** Day grouping happens in SQL
  (`t.climbed_at::date` in `session-feed.ts` and `moonboard-import.ts`), not
  through `parseTickTime`. Corrected sessions regroup — that IS the fix, but it
  is visible and looks irreversible to a climber. Say so in the release comms.
- **Offline re-sync.** `syncTicks` cursors on `updated_at`, so every corrected
  tick re-ships to that climber's devices. Correct, but a fleet-wide run is a
  fleet-wide pull.
- **Re-import duplication.** The `json_import` surrogate id is
  `hash(userId:climbUuid:angle:climbedAt:type)` and is the `ON CONFLICT` arbiter
  on re-import; the cross-source skip keys on the normalised stored
  `climbed_at`. Correcting the timestamp desynchronises both from what a
  re-import of the same export file computes, so the next re-import would insert
  a full duplicate logbook. Fix the importer's dedup first, or accept a
  documented "do not re-import your export after the correction".
- **`created_at` pairing.** `json_import` sets `created_at` from the same suspect
  source and this correction does not touch it, so a row can end up reading
  `created_at` later than its own `climbed_at`. The report counts these.
- **Under-correction is designed in.** Every abstention leaves a genuinely wrong
  row wrong. A climber with no anchor at all gets nothing. A green run is not
  "fixed".

## The rejected alternative: `climbed_at_utc_offset_seconds`

Instead of rewriting the data, add a nullable offset column, keep the stored
value untouched, and subtract at read time. It is genuinely attractive: the
original value stays recoverable forever, and it dissolves three risks above
outright — no self-revert loop, no aurora-twin collapse, no re-import hash
desync.

It is recommended **against**, and the reason is cost, not principle. It is not
"one read-path change":

- 86 call sites of `parseTickTime` / `formatTickRelativeTime` /
  `formatTickAbsoluteTime` across 30+ files would each need auditing.
- The symptom itself — the wrong calendar day — is produced in SQL, not through
  those helpers: `t.climbed_at::date` at `session-feed.ts:160/176/498/1379/1623`
  and `boardsesh_ticks.climbed_at::date` at `moonboard-import.ts:201/210`.
- Grade-model ordering: `grade-model/behavior.ts:71`, `raters.ts:83`.
- A GraphQL field, plus `syncTicks`' select list (`sync/queries.ts:268-270`).
- A SQLite column and migration in `packages/shared/offline-sync`
  (`db/schema.ts:40`, `migrations.ts`) and `table-config.ts:57`.

That is a larger change than the correction, spread across more surfaces, and it
leaves every one of them able to forget the subtraction. Overrule this from the
numbers if you disagree — that is what they are here for.

## Open questions (need a decision)

1. **Is Aurora's naive `YYYY-MM-DD HH:MM:SS` local wall clock or UTC?**
   `normalize-timestamp.ts` and this repo's docs say UTC;
   `tick-offset-inference.ts` and #3909's per-user distribution say local.
   Everything downstream depends on the answer. Try the report's sections (e)
   and (f) first. If they come back ambiguous, the decisive test is to log an
   ascent in the official Kilter app from a device in a known non-UTC zone at a
   recorded instant, run a live pull, and compare the stored value.
2. **If it is local wall clock, should push-back change too?**
   `saveAscent` currently sends UTC. Sending local wall clock instead would
   change what the official Kilter app displays for every Boardsesh-logged
   ascent.
3. **Correct the data, or add the offset column?** See above.
4. **Climbers with no honest anchor at all** — leave them uncorrected (today's
   default), or ask them in-app which zone they were climbing in?
5. **Should `created_at` be corrected alongside `climbed_at`?** Today: no.
6. **Is the importer-dedup fix a hard blocker for the re-import risk,** or is a
   documented caveat acceptable? Recommendation: hard blocker.
7. **Scope and order.** The default is `--origin json_import` only, deferring
   the `aurora_pull` rows because of the twin-collapse interaction. If the
   mechanism probe shows a real fleet-wide spike, the pre-cutoff `native` cohort
   becomes the EASIEST one (a single constant offset, no per-user inference) and
   is probably the right canary.
