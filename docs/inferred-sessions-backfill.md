# Inferred-session backfill

PR #5194 supplies a manual backfill; nothing schedules it. Preparing or deploying
the script does not authorize running `--apply` against production.

## Behaviour

- No flags: inventory eligible users and reconciliation windows. This does not
  predict the number of sessions. A window includes complete UTC days plus runs
  connected across midnight, and can produce several sessions.
- `--simulate`: use the live planner in a read-only, repeatable-read transaction
  per window. Reports new sessions, runs assigned to explicit sessions, merges,
  emptied sessions, and new-session size/duration. Explicit-assignment totals
  include ticks already assigned there; they are not counts of newly moved ticks.
- `--apply`: use the same planner in a serializable transaction per window. Counts
  newly inserted sessions only after commit. The flag enables inference only in
  this process; it does not change the backend service's feature flag.
- The backfill refuses every window requiring a merge or emptied-session removal.
  Existing session comments, votes, and edits need a separate reviewed repair.
  All modes that plan also reject moving a tick out of its explicit session or
  processing a clipped window. Failures roll back that window, log the user ID,
  continue with later users, and produce exit code 1.
- `--delay-ms` pauses between windows for apply/simulation and between users for
  inventory. `--limit` limits users, not windows. `--user` explicitly processes one
  user's complete history, including already-assigned ticks.
- Fleet selection includes only users with unassigned ticks. It is not a repair
  sweep for users whose ticks are all assigned incorrectly. `--resume-from` is
  inclusive and uses the database's user-ID ordering.

The older production figures in the original PR body were measured before the
same-day window fix. Re-measure counts and timing; they are not rollout gates.

## Target and executable

Use the production **backend** service, not web or OTA. The GitHub `Production`
environment's `RAILWAY_BACKEND_SERVICE_ID` currently identifies
`5912f97f-aa1e-4274-8fbf-eed5da0dceb9`. Verify its owning project and production
environment in Railway before connecting. Do not assume the repository variable
`RAILWAY_PROJECT_ID` identifies this project: it is also used by OTA tooling.

After the PR is merged and deployed, open a backend shell with explicit targets:

```sh
railway ssh --project "$BACKFILL_PROJECT_ID" --environment "$BACKFILL_ENVIRONMENT_ID" \
  --service 5912f97f-aa1e-4274-8fbf-eed5da0dceb9
```

The backend Docker image contains source and `tsx`, but does not install a global
`vp` executable. Run its native runtime command from `/app/packages/backend`:

```sh
cd /app/packages/backend
node --import tsx -e 'import("./src/build-release.ts").then(console.log)'
test -f src/scripts/backfill-inferred-sessions.ts
```

Match the stamped build release to the deployed commit containing these fixes.
Use the service's injected `DATABASE_URL`; never paste credentials into commands,
logs, or the PR. Confirm it targets the primary before running either mode.
Use one process. Arrange a persistent operator session and retain its output;
do not assume an SSH disconnect keeps a process alive.

## Read-only preflight

Confirm a recent recoverable database backup and record its timestamp. Record the
deployed commit, selected canary user, start time, and the following primary-DB
baseline through the normal database console:

```sql
BEGIN READ ONLY;
SELECT count(*) AS ticks,
       count(*) FILTER (WHERE session_id IS NULL) AS unassigned_ticks,
       count(DISTINCT user_id) FILTER (WHERE session_id IS NULL) AS eligible_users
FROM boardsesh_ticks;
SELECT origin, count(*) FROM board_sessions GROUP BY origin;
COMMIT;
```

In the backend shell, set a small process-local pool and a query timeout for the
direct PostgreSQL connection. `DB_STATEMENT_TIMEOUT_MS` is a startup parameter;
do not use it with a pooler that rejects startup parameters.

```sh
export DB_POOL_MAX=2 DB_STATEMENT_TIMEOUT_MS=30000
node --import tsx src/scripts/backfill-inferred-sessions.ts
node --import tsx src/scripts/backfill-inferred-sessions.ts --user "$BACKFILL_USER_ID" --simulate --delay-ms 50
node --import tsx src/scripts/backfill-inferred-sessions.ts --simulate --limit 10 --delay-ms 50
```

Choose canaries covering imported history, a lone tick far from the day's larger
run, an explicit session far from loose ticks, and a midnight-crossing run. Inspect
their plans. Require zero failures and zero proposed removals before applying to
those users. Simulation is a per-window snapshot; concurrent logging can change
the later apply plan. A full fleet simulation is useful for identifying blocked
accounts, but can take hours over a public connection.

## Apply, after explicit production approval

First run one reviewed canary:

```sh
node --import tsx src/scripts/backfill-inferred-sessions.ts --user "$BACKFILL_USER_ID" --apply --delay-ms 50 --progress-every 1
```

Inspect that climber's Sessions and logbook: every tick appears, same-day loose
ticks join the expected session, and existing session edits and comments remain.
Re-run the same canary command: it should create zero sessions and preserve IDs.
If both passes succeed, proceed with a bounded batch, then the fleet:

```sh
node --import tsx src/scripts/backfill-inferred-sessions.ts --apply --limit 10 --delay-ms 50 --progress-every 1
node --import tsx src/scripts/backfill-inferred-sessions.ts --apply --delay-ms 50 --progress-every 10
```

Watch database CPU, connection usage, lock waits, backend errors, and per-user
failures. Stop on sustained load or unexpected grouping; increase the delay before
resuming. No deployment, merge, or flag change starts these commands automatically.

## Verify and recover

Repeat the baseline queries and inventory. On a quiet database, tick count should
be unchanged and unassigned ticks should fall to zero except explicitly recorded
failed users. Live imports can add unassigned ticks while the backfill runs; run a
fresh inventory without `--resume-from` afterwards to catch earlier IDs.

Check assignment integrity using read-only queries:

```sql
BEGIN READ ONLY;
SELECT count(*) AS dangling_assignments
FROM boardsesh_ticks t LEFT JOIN board_sessions s ON s.id = t.session_id
WHERE t.session_id IS NOT NULL AND s.id IS NULL;
SELECT count(*) AS invalid_inferred_sessions
FROM board_sessions s
WHERE s.origin = 'inferred'
  AND (s.status <> 'ended' OR s.anchor_tick_id IS NULL
       OR NOT EXISTS (SELECT 1 FROM boardsesh_ticks t
                      WHERE t.id = s.anchor_tick_id AND t.session_id = s.id));
COMMIT;
```

Compare these counts with the preflight baseline too; pre-existing anomalies need
their own investigation. Preserve before/after session IDs for each canary.

Each successful window is already committed. An interruption rolls back only the
in-flight window. Retry the last `starting user=...` with `--user` first, or use
the emitted inclusive recovery command after a completed run with failures. It
points at the first failed user, not the last user visited. Keep the same mode,
delay, and any user limit. Serialization or anchor conflicts can be retried after
the concurrent writer completes; removal/explicit-assignment/truncation failures
need investigation rather than repeated blind retries.

Disabling `INFERRED_SESSIONS_ENABLED` stops ordinary reconciliation but does not
undo committed backfill assignments. There is no destructive undo command here.
If grouping is wrong, stop, preserve logs and the backup, and review a targeted
repair or recovery separately. Never delete inferred sessions as an ad-hoc rollback.
