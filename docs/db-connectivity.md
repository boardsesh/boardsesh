# Database connectivity: connect retries and health probes

How Boardsesh survives a Postgres connect blip, what it deliberately does not
retry, and where to point a monitor.

## The failure this fixes

postgres.js attaches the first query of a fresh connection to the connect
attempt itself (`handler()` → `connect(closed.shift(), query)`,
`postgres/src/index.js:336`). When that connect fails — Railway internal DNS
hiccup, refused TCP connect during a Postgres restart — the query is rejected
outright. One blip, one user-visible 500, even though the statement never
reached the server. postgres.js's own `backoff()` only paces _reconnecting an
already-dropped_ connection; it never re-runs the query that triggered the
connect.

## What is retried

`withDbConnectRetry` (`packages/db/src/client/connect-retry.ts`) retries a
single statement when it fails with one of:

| code                                     | what it means                           |
| ---------------------------------------- | --------------------------------------- |
| `CONNECT_TIMEOUT`                        | postgres.js's own connect timer fired   |
| `ECONNREFUSED`                           | nothing listening (Postgres restarting) |
| `EAI_AGAIN` / `EAI_NODATA` / `ENOTFOUND` | DNS did not resolve the host            |

### Why that is write-safe

postgres.js starts `connectTimer` at `connection.js:343` and cancels it at
`connection.js:552`, inside the ReadyForQuery handler — _before_
`execute(initial)` at `connection.js:568`. DNS and TCP errors come from the
socket before a single protocol byte is written. So an error carrying one of
those codes proves the server never saw the statement: re-running it cannot
double-execute a write. The safety argument is structural, not a judgement call
about which statements "look idempotent".

### What is NOT retried, and why

- **`CONNECTION_CLOSED`** — postgres.js emits it both for a socket that died
  while connecting and for one that died with a query in flight. The error
  object does not distinguish them, so retrying could re-run a write.
- **`read ETIMEDOUT`** (Sentry BOARDSESH-9X) — a `TLSWrap.onStreamRead` failure,
  i.e. an in-flight query dying mid-read. Same ambiguity, and it is a separate
  problem: it predates and outlives the connect bursts.
- **Transactions.** drizzle runs a transaction body against the scoped client
  postgres.js hands its callback, which never passes through the retry wrapper.
  A transaction that loses its connection fails as a whole; it never replays
  half its statements.
- **Multi-statement callbacks.** `withDbConnectRetry` takes a single statement.
  Wrapping a sequence would re-run the earlier statements when a later one
  fails to connect.

## Budgets

Defaults, both overridable by env:

| knob                         | default | meaning                                                      |
| ---------------------------- | ------- | ------------------------------------------------------------ |
| `DB_CONNECT_ATTEMPTS`        | 3       | total attempts including the first                           |
| `DB_CONNECT_RETRY_BUDGET_MS` | 10000   | wall-clock budget, checked before scheduling another attempt |

Backoff is 150ms then 300ms (capped at 600ms) with ±50% jitter, so a fleet
reconnecting after a blip does not hit the database in lockstep.

The budget is what stops the retry from amplifying a real outage. `connect_timeout`
is 30s, so a `CONNECT_TIMEOUT` has already blown the 10s budget by the time it
surfaces: it is rethrown immediately instead of doubling the user's wait and
holding a second pool slot. Fast failures — DNS `EAI_AGAIN`, `ECONNREFUSED`
during a restart — land well inside the budget and do get retried. In other
words this shrinks blips; it does not survive outages. The 2026-08-10 burst
(Sentry BOARDSESH-D8, 03:11–03:54Z) would still have produced errors.

## Where the retry is wired

`createDb()` / `createReadDb()` hand drizzle a retry-wrapped view of the pool
(`withConnectRetry`). drizzle issues every statement through `client.unsafe()`
(`drizzle-orm/postgres-js/session.js:103,106,33`), so all drizzle traffic is
covered — backend resolvers, the Next.js app, scripts.

Not covered:

- **The raw pool** from `createPool()` / `createReadPool()`. Tagged templates
  also build fragments and helpers whose return value is not an awaitable
  query, and cursors consume incrementally, so neither is the re-runnable single
  statement the wrapper is safe for. Raw callers that want the retry wrap one
  statement in `withDbConnectRetry`.
- **`packages/aurora-sync` and `packages/kilter-sync`**, whose runners build
  their own `postgres()` pools directly (`sync-runner.ts` in each) rather than
  going through `@boardsesh/db/client`. They are background jobs that already
  retry at the job level; routing them through the shared builder is a separate
  change (it would also add `ssl: 'require'`, which their local runs do not
  currently use).

## Health endpoints

- **`GET /health`** — status code is governed by Redis alone. It reports
  Postgres as data (`database.reachable`, `database.latencyMs`,
  `database.connectRetries`) but never fails on it. This endpoint is polled by
  `wait-on http-get://localhost:8080/health` in
  `.github/workflows/e2e-tests.yml` (lines 336 and 584), by the dev orchestrator
  (`scripts/dev-orchestrator.ts:424`) and by the branch-deploy compose
  healthcheck (`docs/branch-deploys.md:442`). Gating it on Postgres would strand
  all three on a blip, and party sessions over WebSocket keep working without
  the database.
- **`GET /health/db`** — 503 when Postgres does not answer. This is the
  alertable endpoint.

The probe (`packages/backend/src/services/db-health.ts`) runs `select 1` with a
5s result cache, single-flight dedupe, and a 2s deadline. When the deadline
wins it calls `query.cancel()`: postgres.js queues a query with no timeout of
its own (`postgres/src/index.js:340`), so walking away would leave a zombie
`select 1` that fires whenever the pool recovers, and probes would pile up
through an outage.

## Runbook

- Retries are logged at `warn`: `[db] connect retry 1/3 after EAI_AGAIN …`. Warn,
  not error, so `SentryWinstonTransport` (`utils/sentry-transport.ts:80`, built
  with `level: 'error'`) does not double-report alongside the
  `Sentry.captureException` that `graphql/mask-error.ts` already does for the
  failures that outlive the retry.
- Sustained retries with no errors = the fix is working and the network is
  flaky. Retries _plus_ errors = an outage; check `/health/db`.
- **Alerting is dashboard configuration, not repo code.** Create a Sentry cron /
  uptime monitor against `https://<backend>/health/db` and alert on a non-200.
  Boardsesh's Sentry access from CI is read-only, so this has to be done by hand.
