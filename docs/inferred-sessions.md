# Inferred sessions

A climber who never presses **Start** still climbs in sessions. Inferred sessions
reconstruct them from tick timing, so the Sessions tab reflects what someone actually
did rather than only what they remembered to announce.

This replaces an earlier implementation removed in **#2663**. Read
[What went wrong the first time](#what-went-wrong-the-first-time) before changing
anything here — most of the design exists to avoid a specific failure that already
happened once.

## The rule

Automatic grouping joins consecutive ticks from the same climber when their gap is
**eight hours or less** (`SESSION_GAP_MS`). A gap **over eight hours** is a hard
boundary, including for lone ticks and loose ticks near an explicit session.
Calendar dates never override this boundary.

Existing explicit assignments remain authoritative, even if someone deliberately
keeps a session across a longer gap. Within each connected run, unassigned or inferred
ticks join the nearest explicitly assigned tick's session; ties go to the earlier
tick. Separate explicit sessions keep their original members.

Eight hours is a product heuristic for separating overnight breaks, not proof that
someone slept or returned to the wall. It can still join two visits less than eight
hours apart. Since grouping uses elapsed time, the same evening-to-morning gap has
the same result in every timezone. PostgreSQL timestamps are parsed consistently as
UTC; UTC calendar dates are only used to pad database reads for legacy repair.

## Where they live

Inferred sessions are rows in **`board_sessions`**, marked `origin = 'inferred'`. They
are not a separate table.

That single decision is what keeps the read path simple: `boardsesh_ticks.session_id`
remains the only expression of session membership, so the feed, the detail query, every
batch enricher, votes, comments and `validateEntityExists` all work on them unchanged,
with no new join and no discriminating branch.

An inferred row is always already over: `status = 'ended'`, `started_at` / `ended_at`
from its first and last tick, `is_permanent = false`, `board_path = NULL` (its ticks may
span several boards, so there is no one path to record).

**Every live-session path must scope itself to `origin = 'explicit'`** — the auto-end
sweep, the join guard, the leader checks, presence, queues, push targeting. An inferred
row reaching any of those is a bug.

### Identity: `anchor_tick_id`

A session's identity is pinned to the lowest `boardsesh_ticks.id` it held when created.
Tick ids are `bigserial`, assigned at insert and never reassigned, so the anchor holds
still even as the run reshapes around it.

This matters because **out-of-order arrival is normal, not exceptional**: 96 % of
`kilter_pull` ticks and every MoonBoard import land back-dated by more than a day. A
session's first *climb* changes often; its first *row* does not.

## Reconciliation

`@boardsesh/session-inference` is pure TypeScript with no database access, so the
algorithm is testable in isolation. Callers load a window, call `reconcileWindow`, and
apply the result in one transaction.

```
expandReconciliationWindow(ticks, from, to)
  include whole UTC days, expanding connected runs across midnight
  stop only at a >8h gap across different UTC days on BOTH sides
    → include legacy same-day session anchors when splitting old assignments

reconcileWindow({ ticks, existingInferred, existingExplicit })
  → runs              each run and the session it belongs to
                      (sessionId null ⇒ caller mints a new session)
  → merges            {survivorId, loserId} — re-point social rows, THEN delete
  → emptiedSessionIds sessions an explicit session took every tick from
```

A read window can hold several sessions; it does not group them together. Whole-day
padding keeps anchors from the former same-day grouping policy visible when old
sessions split. The database loader widens
up to a 192-hour radius; if the result is still clipped, live inference leaves
assignments unchanged so the tick write can commit. The backfill reports a failure
and leaves that window untouched. Database `climbed_at` strings are interpreted as UTC on every host.

The window is the important part. Reconciling always decides about complete runs, so a
tick inserted anywhere — mid-run, before the first, bridging two — produces a correct
answer rather than a locally-plausible one.

`reconcileWindow` is idempotent: re-running it over its own output changes nothing, so
every writer can call it — save, edit, delete, importers, and the offline outbox drain.

That idempotency is **sequential**. Two writers reconciling the same previously
unassigned run both read `sessionId: null` and both try to create a session, so the
unique partial index on `board_sessions.anchor_tick_id` (where `origin = 'inferred'`)
settles it: the loser's insert fails and it retries the window, finding the anchor and
inheriting the row. Callers must therefore treat a unique violation on that index as a
retry signal, not an error.

### Merges

When a back-dated tick bridges two inferred sessions, one absorbs the other. The
survivor is whichever the climber has edited (`user_edited`), and otherwise the earlier
anchor, so the outcome never depends on row order.

**Always re-point votes and comments onto the survivor before deleting the loser.** The
old implementation deleted emptied sessions outright, orphaning their social rows and
leaving migration `0120` to sweep up the debris.

## Rollout

Reconciliation is gated on **`INFERRED_SESSIONS_ENABLED=true`** in the backend
environment. The backend has no feature-flag framework — the registry in
`docs/feature-flags.md` is a web concern — so this is a deploy-time toggle, and
unsetting it is the rollback.

With it off, `reconcileInferredSessions` returns immediately: no rows are written and
no query is issued. Nothing reads inferred sessions yet either, so the two halves can
be enabled independently.

The tick writers call it inside their own transaction, so a climb and its session
assignment commit or roll back together:

| writer | when |
| --- | --- |
| `saveTick` | on the new tick's `climbed_at` |
| `updateTick` | on the old and the new `climbed_at` — an edit can move a tick between runs |
| `deleteTick` | on each removed tick's `climbed_at` — a deletion can split a run |

Still to wire: the Aurora / Kilter / MoonBoard / JSON importers (batched — one call per
climber per contiguous window, never per tick, since a single import can carry 300k
rows) and the offline outbox drain.

## Historical backfill

The manual script, production preflight, canary, and recovery procedure are in
[inferred-sessions-backfill.md](./inferred-sessions-backfill.md). It defaults to a
read-only inventory; `--simulate` plans grouping and `--apply` commits one complete
window at a time. The backfill refuses windows that remove existing sessions, and
reconciliation rejects moving ticks out of their assigned explicit sessions.

## What went wrong the first time

The original feature kept a parallel **`inferred_sessions`** table with
`boardsesh_ticks.inferred_session_id` alongside `session_id`. Everything below follows
from that one choice:

- The feed `UNION ALL`'d a materialized table against a live tick aggregate, with
  `ORDER BY … OFFSET/LIMIT` above the union — so both arms had to be fully materialized
  and sorted on every public request.
- `total_attempts` meant different things per arm (a plain count on one side, weighted
  `attempt_count` arithmetic on the other) yet shared one feed column.
- Four batch enrichers keyed on `COALESCE(session_id, inferred_session_id)` in a
  `WHERE`, which is not sargable — each seq-scanned the tick table, four per feed page.
- `sessionDetail` probed one table, then the other, then branched every field.
- Two duplicate builders (backend job + a web copy for a Vercel cron) had to keep a
  UUIDv5 namespace constant in sync by hand.

Session ids were `uuidv5(userId + ':' + firstTickTimestamp)`, so a back-dated tick that
became the new earliest climb re-keyed the session and orphaned its votes and comments.
Assignment compared each new tick against only the user's *most recent* tick, so a
back-dated tick more than 4 h from that one minted a fresh session even when it sat
squarely inside an existing session's span.

**The stated reason for removal was a misdiagnosis.** #2663 cited "SQL errors around the
mixed inferred/explicit session query path". Commit `665af9408`, two months later,
identified those errors as Postgres parallel-query shared-memory exhaustion (pgCode
`53100`) from an unbounded parallel hash aggregate — not specific to the inferred branch,
and fixed by `withSerialPlan`, which still guards the feed query today. Error masking had
stripped the SQL text, so every database failure looked like one anonymous issue.

Keep `withSerialPlan` around the feed query. It is the real fix, and it is easy to drop
by accident while editing that CTE chain.

## Related

- `packages/shared/session-inference/` — the algorithm and its tests
- `packages/db/src/schema/app/sessions.ts` — `sessionOriginEnum`, `anchor_tick_id`
- `packages/backend/src/graphql/resolvers/social/session-feed.ts` — the read path
- `docs/scheduler.md` — where a safety-net reconciliation sweep belongs
