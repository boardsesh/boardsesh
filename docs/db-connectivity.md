# Database connectivity: connect retries and health probes

How Boardsesh survives a Postgres connect blip, what it deliberately does not
retry, and where to point a monitor.

## The failure this fixes

postgres.js attaches the first query of a fresh connection to the connect
attempt itself (`handler()` → `connect(closed.shift(), query)`,
`postgres/src/index.js:337`). When that connect fails — Railway internal DNS
hiccup, refused TCP connect during a Postgres restart — the query is rejected
outright. One blip, one user-visible 500, even though the statement never
reached the server. postgres.js's own `backoff()` only _paces_ the next connect
attempt (see "postgres.js paces its own connects" below); it never re-runs the
query that the failed connect rejected.

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
`execute(initial)` at `connection.js:567`. DNS and TCP errors come from the
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
holding a second pool slot. During a blip — a DNS `EAI_AGAIN`, an `ECONNREFUSED`
while Postgres restarts — the attempts are milliseconds apart and the retry does
its job. In other words this shrinks blips; it does not survive outages. The
2026-08-10 burst (Sentry BOARDSESH-D8, 03:11–03:54Z) would still have produced
errors.

### postgres.js paces its own connects, and that is what the budget bounds

`ECONNREFUSED` is only cheap for the first few failures. postgres.js gates every
connect on a pool-wide backoff of its own: `options.shared.retries` increments on
each errored close (`connection.js:455`), `backoff(retries)` is
`(0.5 + rand/2) * min(3^retries/100, 20)` seconds (`index.js:511`), and
`connection.connect()` waits that long before it even opens a socket
(`connection.js:113-116` → `reconnect()` at `:362`). The counter is shared across
the pool and only resets on a successful connect (`connection.js:568`).

Measured against a dead port with **stock postgres.js and no wrapper at all**,
nine sequential connects take 7, 2, 17, 43, 131, 637, 1305, 2540, 14204 ms. Deep
into an outage a single connect already costs seconds today.

What the retry changes is that one statement spends up to `DB_CONNECT_ATTEMPTS`
connects instead of one, so that counter ramps roughly three times faster and one
request can span two attempts of a ramping delay. The wall-clock budget is the
bound: it is checked after each attempt returns, so once a single attempt costs
more than `DB_CONNECT_RETRY_BUDGET_MS` the loop stops there. It cannot preempt an
attempt already in flight, so worst case a request absorbs about two attempts
instead of one. If an incident ever shows that trade going the wrong way, lower
`DB_CONNECT_RETRY_BUDGET_MS` (or set `DB_CONNECT_ATTEMPTS=1` to turn the retry
off) rather than reaching into postgres.js's backoff.

The connect-retry tests pin their pools to `backoff: () => 0` so they measure this
wrapper's loop rather than that ramp.

## What actually exhausts a pool: one uncached read, run concurrently (#4463)

The deadlines above bound how long a caller _waits_. Neither bounds how many
connections one logical read can hold at once, and that is what took the
backend down in #4463.

The home page's two backend reads — `popularBoardConfigs` and
`recentBetaLinks` — are Redis-cached with a long TTL and both fall through to
a heavy statement on a miss. The fall-through had no concurrency control, so N
simultaneous visitors during a cold window meant N simultaneous copies, each
holding one of the pool's ten connections. `popularBoardConfigs` costs 82 s on
the dev-db image; the one production observation on record is ~10 s cold, read
through the sitemap's copy of the same statement
(`packages/web/app/lib/server-popular-configs.ts`). Either number times ten
visitors empties the pool, and after that every _other_ query in the process
queued forever on the untimed acquire queue described in the next section.
`{ __typename }` kept answering in single-digit milliseconds through the same
event loop, which is why it read as anything but saturation.

`packages/backend/src/utils/single-flight.ts` is the fix: concurrent callers of
one key share one in-flight promise, so a cold window costs one statement and
one connection instead of one per caller. It is deliberately not a cache — the
promise is dropped the moment it settles. A process-local copy
(`REDISLESS_FALLBACK_TTL_MS`) covers deployments with no Redis, where
single-flight alone would still re-run the statement for the first caller after
every completion.

The distributed Redis lock those reads' warm-up jobs take is not a substitute:
it only stops a second _node_ from refreshing, and it is not held on the
resolver path at all.

**When adding a cache-with-fallthrough on a read that costs more than a few
hundred milliseconds, wrap the fall-through.** The Redis hit rate is not the
safety property; the concurrency of the miss is.

## Front-door read deadlines and pool sizing (#4461)

The connect retry above bounds a _failed_ connect. It does nothing about a
_saturated_ pool, and that is the failure the climb sitemaps invite: postgres.js
has no acquire timeout, and its internal queue is unbounded and untimed
(`postgres/src/index.js:341`). A statement that cannot get a connection waits
forever, so many concurrent SSR renders against a slow database look like a hang
rather than an error.

`packages/web/app/lib/db/read-deadline.ts` bounds one read client-side. It races
the pending query against a timer and rejects with `DbReadTimeoutError`
(`code: 'DB_READ_TIMEOUT'`) when the timer wins. It is wired at four
front-door reads — the two statements behind `getClimb`, the all-angles
stats select, and the shared climb search — and deliberately **not** inside
`withConnectRetry` or `packages/db`, where it would change behaviour for the
backend, the sync runners and every script.

**Cancellation covers three of the four.** On a timeout the helper calls
`query.cancel()` the way the health probe does, so a timed-out statement does not
fire later against a recovered pool. That only works for raw postgres.js
queries. The list front door's search is drizzle-issued and exposes no
`.cancel()`, so there the deadline sheds the _caller_ while the statement runs to
completion still holding its connection. Worth knowing mid-incident: shedding
list renders does not immediately hand connections back.

Cancelling a **queued** query is free — postgres.js removes it from the queue and
rejects it locally. Cancelling one that is already **executing** opens a
brand-new connection to send the cancel request, against a database that is by
construction already struggling, and postgres.js keeps that connection's promise
internally (`Query.cancel()` returns `null`), so a failure to open it surfaces as
an unhandled rejection the runtime logs. Accepted: a zombie statement firing
against a recovered pool is worse than a log line.

**One budget per request, not per statement.** The climb page issues three reads
in sequence, so three independent 6 s deadlines would be an ~18 s request
ceiling — the opposite of shedding load. `app/lib/db/request-read-budget.ts`
puts one deadline timestamp in React's per-render `cache` scope and hands each
read whatever the earlier ones left, floored at 500 ms. Outside a render scope
(scripts, unit tests) React's `cache` is a passthrough and each read gets its own
deadline.

**Since #4650 the same helper also wraps four more reads: the unauthenticated
OG image routes**, one `withReadDeadline` call around each route's whole DB
phase — `og-setter`, `og-profile`, `og-playlist`, `og-session` (`/api/og/climb`
needs nothing; its `getClimb` read is already covered above). Those add a
third outcome to the table below: a timed-out or rejected OG read does not
404 or 500, it redirects to `/opengraph-image` — the existing DB-free branded
card — with a 60 s CDN `s-maxage`. Unfurlers render nothing on a bare 5xx and
cache that failed scrape for days, so a degraded-but-present card beats a
blank embed for that whole window, and the short `s-maxage` lets the CDN
answer a burst of scraper retries during the brownout without sending each
one at the database.

### What the reader sees when it fires

| condition                           | before                               | after                                           |
| ----------------------------------- | ------------------------------------ | ----------------------------------------------- |
| climb row absent                    | 404                                  | 404 (unchanged — now for the right reason)      |
| board slug resolves to nothing      | 404                                  | 404 (unchanged)                                 |
| read fails or deadlines, climb page | hung to the platform limit, then 404 | 500 at ~6 s per request                         |
| read fails or deadlines, list page  | 200 with zero climbs                 | 500 at ~6 s                                     |
| backend `boardBySlug` fails, `/b/…` | 404                                  | 500                                             |
| backend GraphQL wedged              | climb page hung indefinitely         | similar climbs / beta links render empty at 3 s |

The 5xx is the point. Google retries a 5xx and keeps the URL, while a 404 — or a
200 with nothing on it — on a sitemapped URL reads as "drop this page".

**The CDN does not hide it, and that is fine.** `stale-while-revalidate` only
cushions a URL whose `age` has already passed `s-maxage`: climb views are covered
for age 1 h–7 h, list front doors for 24 h–7 d, and Vercel supports no
`stale-if-error`. A cold-MISS crawl of a long-tail sitemap URL therefore sees the
500 directly. The asymmetry that matters is what happens next: 5xx is **not** a
cacheable status on Vercel, so it is never pinned, whereas the 404 this replaces
**is** cacheable — one blip used to stick a 404 in the CDN for a full `s-maxage`.

A genuinely missing climb is also not negatively cached: `fetchClimbFromDb`
throws a private not-found error inside `unstable_cache` (which never stores a
rejection) and the caller turns it back into `null`, so a climb crawled minutes
before its import lands recovers on the next request rather than 404-ing for the
rest of the hour-long entry.

### Budgets

| knob                      | default        | meaning                                                                                  |
| ------------------------- | -------------- | ---------------------------------------------------------------------------------------- |
| `DB_READ_DEADLINE_MS`     | 6000           | web front door: wall clock for one _request's_ reads (queue wait + connect + execute)    |
| `DB_POOL_MAX`             | 10 (Vercel: 3) | postgres.js `max`, clamped to a floor of 2                                               |
| `DB_POOL_IDLE_TIMEOUT_S`  | 30 (Vercel: 5) | seconds an idle connection is held open; `0` means "never close one" and is not clamped  |
| `DB_STATEMENT_TIMEOUT_MS` | unset          | emits a `statement_timeout` startup parameter — **off by default**, see the hazard below |

6000 sits deliberately below `DB_CONNECT_RETRY_BUDGET_MS` (10000): during a
brownout the front door should shed load rather than spend a second and third
connect attempt holding a pool slot while a crawler waits. That comparison only
holds because the budget is per request — see the shared-budget note above.

The pool knobs default to the values that used to be hard-coded — except on
Vercel, where an unset knob now falls back to the serverless pair (`max` 3,
idle 5 s; `process.env.VERCEL` selects it, an explicit env var still wins).
The split exists because peak server-side connections scale with
**instance count × connections held idle**, not with per-instance `max` — a
fleet of serverless instances each sitting on a few idle connections for 30 s
is the term that grows during a crawl burst. On 2026-08-29 exactly that
exhausted the shared `max_connections = 200` (Sentry BOARDSESH-FS: crawler
bursts on climb-view SSR held ~10 idle connections per lambda) and starved the
backend's `POST /graphql` alongside (BOARDSESH-A1). Lowering `DB_POOL_MAX` and
`DB_POOL_IDLE_TIMEOUT_S` on a serverless deployment shrinks that footprint;
raising `max` never helps.

### The `statement_timeout` hazard

`DB_STATEMENT_TIMEOUT_MS` ships off. PgBouncer in transaction-pooling mode
rejects startup parameters that are not in `ignore_startup_parameters`, and
`statement_timeout` is not among the defaults — so setting it against a pooled
`DATABASE_URL` fails _every connection_ instead of bounding one query. Two
paths, chosen by what the URL actually points at:

- **Direct Postgres** — set `DB_STATEMENT_TIMEOUT_MS` on the deployment.
- **Pooled (PgBouncer) URL** — do it database-side instead, with
  `ALTER ROLE <app_role> SET statement_timeout = '8s'`, which passes through a
  pooler transparently.

`psql "$DATABASE_URL" -c 'show pool_mode;'` tells you which you have: a direct
Postgres errors, PgBouncer answers.

### There is no web health probe

`/health` and `/health/db` below are **backend** endpoints. `packages/web` has
none, so during a web-pool incident `/health/db` stays green and says nothing
about the surface that is actually failing. That gap is not filled here.

## Where the retry is wired

`createDb()` / `createReadDb()` hand drizzle a retry-wrapped view of the pool
(`withConnectRetry`). drizzle issues every statement through `client.unsafe()`
(`drizzle-orm/postgres-js/session.js:33,43,65,103,106`), so all drizzle traffic is
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
its own (`postgres/src/index.js:341`), so walking away would leave a zombie
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
- Since #4862 a connection-class database failure (SQLSTATE class 08/53, the
  57P0x shutdown codes, `CONNECT_TIMEOUT`/`ECONNREFUSED`-style driver codes)
  reaches GraphQL clients as an **HTTP 503**, not a 200 with a masked error body
  (`graphql/mask-error.ts`, `isDatabaseUnavailableCode`). A 5xx rate on
  `POST /graphql` is therefore real outage signal; constraint, data and syntax
  errors still ride the masked 200 so clients can give up on them.
- **Alerting is dashboard configuration, not repo code.** Create a Sentry cron /
  uptime monitor against `https://<backend>/health/db` and alert on a non-200.
  Boardsesh's Sentry access from CI is read-only, so this has to be done by hand.
