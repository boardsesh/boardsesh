# Database connectivity: connect retries and health probes

How Boardsesh survives a Postgres connect blip, what it deliberately does not
retry, and where to point a monitor.

## TLS verification

The shared primary and replica pools honor explicit `sslmode=verify-full`:
both certificate trust and hostname are checked, including for local hosts.
An explicit verification request is never replaced by the legacy `require`
default. Remote URLs without `verify-full` retain the existing
encryption-only default; this change does not migrate other deployments' trust.
Repeated `sslmode` parameters are rejected rather than choosing a driver-specific
precedence.

The hold detector requires `verify-full` for remote connections and accepts only
`sslmode` and `application_name` URL query options, without duplicates. Use
`NODE_EXTRA_CA_CERTS` at process startup for a privately issued trust certificate,
not `sslrootcert` (the data and queue drivers interpret that option differently).
Both drivers must reject an untrusted certificate and a hostname mismatch before
the worker is deployed. Never set `NODE_TLS_REJECT_UNAUTHORIZED=0`.

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

and, once traffic goes through PgBouncer, when it fails with SQLSTATE `08P01`
and exactly one of these PgBouncer messages:

| message                                          | observer label                     | what it means                                      |
| ------------------------------------------------ | ---------------------------------- | -------------------------------------------------- |
| `query_wait_timeout`                             | `08P01:query_wait_timeout`         | waited 5 s for a server connection and got none    |
| `client_login_timeout (server down)`             | `08P01:client_login_timeout`       | login waited for a server that never answered      |
| `no more connections allowed (max_client_conn)`  | `08P01:max_client_conn`            | PgBouncer already holds 500 client connections     |
| `server login has been failing, cached error: …` | `08P01:server_login_retry`         | PgBouncer's last upstream login failed; fail fast. Prefix match: PgBouncer truncates the cached error |

The last one is matched by prefix, because PgBouncer cuts every message to
127 bytes. The cached upstream error can name a role or host, so it never goes
into the label.

### Why that is write-safe

postgres.js starts `connectTimer` at `connection.js:343` and cancels it at
`connection.js:552`, inside the ReadyForQuery handler — _before_
`execute(initial)` at `connection.js:567`. DNS and TCP errors come from the
socket before a single protocol byte is written. So an error carrying one of
those codes proves the server never saw the statement: re-running it cannot
double-execute a write. The safety argument is structural, not a judgement call
about which statements "look idempotent".

The PgBouncer errors rest on two separate guarantees.

1. **PgBouncer only sends them to a client with no server.** `query_wait_timeout`
   and `client_login_timeout (server down)` come from the janitor loop over
   `waiting_client_list` (PgBouncer 1.25.2 `janitor.c:431-475`), which holds only
   waiting clients. A waiting client's statement is still in PgBouncer's buffer.
   `max_client_conn` is sent during login (`client.c:1078`). The login-retry
   message comes from `check_fast_fail()` (`objects.c:880`), which `find_server()`
   only reaches for a client without a linked server. In transaction mode a
   client keeps its server until the transaction ends, so none of these can land
   in the middle of a transaction either.
2. **postgres.js only hands them to a statement it has not sent.** PgBouncer
   closes the socket right after the error, without ReadyForQuery. A statement
   that was already written therefore fails with `CONNECTION_CLOSED`, which is
   not retried. The `08P01` error reaches a caller only on the startup path,
   where the caller's statement is still the connection's unsent `initial`
   query.

Measured on 2026-09-26 against PgBouncer 1.25.2 and PostgreSQL 18.6, with all 45
server connections held by `pg_sleep`: a statement on an already-open client
connection failed after 5 s with `CONNECTION_CLOSED`; the first statement on a
new connection failed after 5 s with `08P01 query_wait_timeout`, was retried
once, and succeeded when a server freed up. With PostgreSQL stopped, new
connections failed with `08P01 query_wait_timeout`; 520 simultaneous clients got
106 `08P01 no more connections allowed (max_client_conn)`. A bad upstream
password comes back as PostgreSQL's own `28P01`, which is not retried.

`query_timeout` is not on the list: PgBouncer also sends it for a client whose
statement is running on a server. PgBouncer 1.25.2 no longer has a
`pgbouncer cannot connect to server` message; an unreachable server shows up as
`query_wait_timeout`.

The wall-clock budget bounds the cost. A `query_wait_timeout` spends 5 s, so the
10 s budget allows one retry and rethrows the second failure, about 10 s in all.
The web front door's 6 s read deadline sheds the request before that.

### What is NOT retried, and why

- **`CONNECTION_CLOSED`** — postgres.js emits it both for a socket that died
  while connecting and for one that died with a query in flight. The error
  object does not distinguish them, so retrying could re-run a write. Behind
  PgBouncer this includes a `query_wait_timeout` on a connection that was
  already open: the pooler never ran that statement, but the error cannot prove
  it.
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

## Socket disconnects and transaction cleanup (#5299)

The workspace patches and pins `postgres@3.4.9` until an upstream release passes
the backend disconnect/recovery regressions. Both Node entry points (ESM and
CommonJS) receive the patch. It lives in `packages/db/patches`, outside the root
`patches` directory that mobile hashes into its native runtime fingerprint.
The backend, web, and sync Dockerfiles copy it before fetching dependencies;
the deployment-input guard checks every configured patch directory. `Dockerfile.ci`
needs no extra line — it copies all of `manifests/packages` before `pnpm fetch`,
so a patch stored inside a workspace package rides along.

A socket closing during a transaction can reject its query, then trigger the
driver's automatic rollback after `closed()` has nulled the socket. That small
write schedules `nextWrite` on the immediate queue, where the null dereference
escapes the query promise and kills the backend. No application Postgres
`onclose` hook is involved in the reproduced path.

[Upstream PR #1168](https://github.com/porsager/postgres/pull/1168) guards that
write. The guard alone prevented the crash in our reproduction but left a
rollback in the connection's query state, hanging subsequent pool queries.
Our patch also records failure for the transaction's lifetime, rejects its
queued and later statements (including automatic rollback/commit), and clears
the write buffer and immediate handle on close/termination. Closing also clears
the failed connection's result/error state so a server FATAL response cannot
reject the first query on a replacement socket. A transaction
callback resuming after pool reconnection still fails against its original
transaction; it cannot write through the replacement connection.

The existing connect retry policy is unchanged. An interrupted transaction
fails; its statements are never replayed. Ordinary application errors still
roll back normally, including savepoints. Sentry retains its normal fatal-error
handling; there is no process-level exception suppression.

`postgres-disconnect.test.ts` runs isolated Node processes against both installed
entry points, using controlled socket closes and termination of the test's own
live PostgreSQL connection. It checks query settlement, repeated pool reuse,
fresh transactions, delayed callbacks, and startup write-timer recovery. Keep
these tests when upgrading; remove the override and patch only when the new
release passes them. After deployment, check BOARDSESH-GH and replica restarts,
and confirm `/health/db` recovers after database availability returns.

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

`popularBoardConfigs` has since left this pattern entirely: its readers never
run the statement. A daily pg-boss job computes the list and writes it over the
old one (`packages/backend/src/services/popular-board-configs.ts`); a reader on
a miss gets the last list its process saw, or `[]`, and queues a refresh. The
statement itself now tests `required_set_ids <@ set_ids` instead of walking
every hold, about 30 s for all configs where it was 548 s.

**When adding a cache-with-fallthrough on a read that costs more than a few
hundred milliseconds, wrap the fall-through.** The Redis hit rate is not the
safety property; the concurrency of the miss is.

`similarClimbs` is the third read to take that shape (#4968,
`graphql/resolvers/climbs/similar-climbs-cache.ts`). Measured on the dev
catalogue — 893k climbs, 5.5M Kilter `board_climb_holds` rows, serial plan — a
typical 18-hold Kilter climb runs **4 831 ms on a fresh Postgres and 205 ms
warm**; the 198-hold tail is 7 860 ms cold and 1 542 ms warm. The cold figure
for the typical case is 1.6x the front door's 3 s deadline, which is why #4968
reads as a cold-cache failure rather than a slow-query one. (Parallelism is not
the variable: warm serial 1 542 ms vs 1 566 ms with
`max_parallel_workers_per_gather = 4`, and the planner chooses no `Gather` node
for this shape — so `withSerialPlan` costs it nothing measurable.) It differs
from the other two in one way: its key is
per climb across the whole catalogue, so it takes **no** `REDISLESS_FALLBACK_TTL_MS`
process-local copy. An unbounded local map in a long-lived process is a worse
failure than re-running the statement, and single-flight alone still covers the
concurrency of the miss, which is the half that protects the pool.

## Front-door read deadlines and pool sizing (#4461)

The connect retry above bounds a _failed_ connect. It does nothing about a
_saturated_ pool, and that is the failure the climb sitemaps invite: postgres.js
has no acquire timeout, and its internal queue is unbounded and untimed
(`postgres/src/index.js:341`). A statement that cannot get a connection waits
forever, so many concurrent SSR renders against a slow database look like a hang
rather than an error.

`packages/web/app/lib/db/read-deadline.ts` bounds one read client-side. It races
the pending query against a timer and rejects with `DbReadTimeoutError`
(`code: 'DB_READ_TIMEOUT'`) when the timer wins. It is wired at three
front-door reads — the alias-resolving `getClimb` statement, the all-angles
stats select, and the shared climb search — and deliberately **not** inside
`withConnectRetry` or `packages/db`, where it would change behaviour for the
backend, the sync runners and every script.

**Cancellation covers two of the three.** On a timeout the helper calls
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

**One budget per request, not per statement.** The climb page issues two reads
in sequence, so two independent 6 s deadlines would be a ~12 s request
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
| backend GraphQL wedged              | climb page hung indefinitely         | similar climbs / beta links degrade at 3 s      |

Since #4968 "degrade" is not "render empty". Both sections return
`{ status: 'unavailable' }` rather than `[]`, because `[]` is also what a climb
nobody has filmed looks like and the page was publishing "No beta filmed yet."
on the strength of a timeout — 6,922 + 748 renders in fourteen days. Each
section now says it did not load, and similar climbs additionally ship WITHOUT a
React Query seed so the reader's own browser refetches on hydration: the retry
happens off the server-render budget and against the reader's IP rather than the
web server's single shared one. There is deliberately no server-side retry — a
second attempt spends another 3 s pushing work at the pool that just failed.

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
| `DB_POOL_MAX`             | 5 (Vercel: 3)  | postgres.js `max`, clamped to a floor of 2                                               |
| `DB_POOL_IDLE_TIMEOUT_S`  | 30 (Vercel: 5) | seconds an idle connection is held open; `0` means "never close one" and is not clamped  |
| `DB_STATEMENT_TIMEOUT_MS` | unset          | emits a `statement_timeout` startup parameter — **off by default**, see the hazard below |

6000 sits deliberately below `DB_CONNECT_RETRY_BUDGET_MS` (10000): during a
brownout the front door should shed load rather than spend a second and third
connect attempt holding a pool slot while a crawler waits. That comparison only
holds because the budget is per request — see the shared-budget note above.

The pool knobs default to `max` 5 and idle 30 s (see the connection budget
under PgBouncer below for why `max` fell from 10) — except on
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

Do not use `SHOW pool_mode` on the application database to tell them apart.
PgBouncer answers its `SHOW` commands only on its admin database; on an
application database it forwards the query to PostgreSQL. Check the host in the
URL instead: the pooler listens on port 6432.

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

## PgBouncer in front of production (#4842)

**Status: built, not deployed.** Every production client still connects
straight to the PG18 primary, `postgis---pg18.railway.internal:5432`.

### Shape

- One Railway service running `ghcr.io/boardsesh/boardsesh-pgbouncer`, built from
  `deploy/pgbouncer/` by `.github/workflows/pgbouncer-image.yml`. **One replica.**
  Its limits are per process, so a second replica doubles the database budget.
- Transaction pooling. 40 server connections plus 5 reserve, hard-capped at 45
  for the database and for the upstream role. Up to 500 client connections. A
  client that waits 5 s for a server is disconnected (`query_wait_timeout`).
  Server connections open on demand (`min_pool_size = 0`) and close after 300 s
  idle, so the pooler holds at most as many servers as there are clients in a
  transaction at once.
- TLS on both sides. Clients connect to port 6432 on the private network. Upstream
  is `postgis---pg18.railway.internal:5432` with `server_tls_sslmode = verify-full`,
  trusting only the Boardsesh DR Primary CA passed in `PGBOUNCER_SERVER_TLS_CA`.
  That name is one of the two SANs on the primary's leaf
  ([pg-primary-tls-rollout.md](./pg-primary-tls-rollout.md)). **Before deploying,
  confirm the primary serves the private-CA leaf**: `docs/pg-primary-tls.json`
  still lists it as a pending rollout, and verify-full refuses the old
  certificate, so every server login would fail.
- App clients keep `prepare: false` and PgBouncer runs with
  `max_prepared_statements = 0`. Session features stay out of pooled traffic:
  only `pg_advisory_xact_lock`, `SET LOCAL` only inside transactions. pg-boss 12
  is transaction-mode safe as the backend uses it: unnamed statements,
  transaction-scoped advisory locks, and no LISTEN (it only listens when
  `notify` is on, which the backend does not set).

### What goes through it, and what stays direct

Pooled, one change at a time, each watched as its own connection-budget event:

1. The `boardsesh-web` Railway service's `DATABASE_URL` (postgres.js, `DB_POOL_MAX` from its env).
2. The backend's `DATABASE_URL`. It carries both the postgres.js pool
   (2 replicas x `DB_POOL_MAX` 5) and pg-boss (2 x `PGBOSS_POOL_SIZE` 2):
   `packages/backend/src/services/job-queue.ts` builds pg-boss from the same
   connection string, so the two move together. pg-boss uses the `pg` driver,
   which the connect retry above does not cover; a `query_wait_timeout` there
   fails that pg-boss call, and pg-boss's own job retry and supervision pick it up.

Direct, always:

- **Migrations.** `migrate.ts` reserves one session for `SET ROLE`, which
  transaction pooling cannot keep. The deploy checks that `MIGRATOR_DATABASE_URL`
  points at `DATABASE_DIRECT_ENDPOINT` before migrating (see
  [production-deploy.md](./production-deploy.md)).
- **The standby's walsender.** Replication is a separate protocol PgBouncer does
  not carry. It counts against `max_wal_senders` (10), not `max_connections`.
- **The homelab sync daemons**, which reach the primary over the public TCP proxy.
  PgBouncer has no public listener.
- **`boardsesh_readonly`** investigations (at most 5 connections).

The hold detector is a separate service with its own `DATABASE_URL`
(`DB_POOL_MAX` 3 plus a pg-boss pool of 3). It stays direct unless that URL is
changed on purpose.

### Connection budget at `max_connections = 100`

PostgreSQL keeps 3 slots for superusers (`superuser_reserved_connections`
default), which leaves 97 for application roles. The standby's walsender counts
against `max_wal_senders`, and autovacuum and parallel workers have their own
slots, so none of them appear below.

Every pool is sized by one of three knobs. The code defaults apply wherever the
deployment sets no env var:

| knob               | default | where it is read                                                              |
| ------------------ | ------: | ----------------------------------------------------------------------------- |
| `DB_POOL_MAX`      |       5 | `DEFAULT_POOL_MAX`, `packages/db/src/client/postgres.ts` (Vercel: 3)          |
| `PGBOSS_POOL_SIZE` |       2 | `DEFAULT_PGBOSS_POOL_SIZE`, `packages/backend/src/services/job-queue.ts`      |
| worker pools       |   2 + 1 | fixed by `packages/backend/src/workers/config.ts`; other values fail startup |

Until 2026-09-26 the first two were 10 and 4. postgres.js hands each query to
the next open connection in turn, so a busy pool sits at its `max` even though
the whole fleet averages under one active statement (0.82 in the 2026-09
audit). The ceiling is what counts, not the average.

| client                                   | before (2026-09-26) | after these defaults |
| ---------------------------------------- | ------------------: | -------------------: |
| backend postgres.js, 2 replicas          |              2 x 10 |                2 x 5 |
| backend pg-boss, 2 replicas              |               2 x 4 |                2 x 2 |
| web postgres.js, 1 replica (env)         |                  10 |                    4 |
| hold detector, postgres.js 3 + pg-boss 3 |                   6 |                    6 |
| homelab sync daemons, about 3            |             3 x 10 |                3 x 5 |
| homelab background workers, 4 roles      |           4 x (2+1) |            4 x (2+1) |
| `boardsesh_readonly` (role cap)          |                 ≤ 5 |                  ≤ 5 |
| migrator, during a deploy                |                   1 |                    1 |
| **ceiling, steady**                      |            **≤ 92** |             **≤ 57** |
| **+ old backend fleet draining (15 s)**  |           **≤ 120** |             **≤ 71** |

Web's 4 needs `DB_POOL_MAX=4` on the `boardsesh-web` Railway service, which set
it to 10 explicitly; the code default does not reach it. The homelab rows are
ceilings: the daemons held 1 to 2 connections each in the audit, and the
background workers only run once a role is enabled. The daemons should pin
`DB_POOL_MAX=3` in their own env, which brings the steady ceiling to 51 and the
deploy ceiling to 65.

The ceiling only matters when every pool fills at once, which a slow database
does cause: requests pile up, every pool opens its last connection, and the
next client gets `53300 too many connections`. The before column could not fit
97 during a deploy. The after column fits with 26 to spare.

### Lowering `max_connections` to 60, last

Each slot reserves a small amount of shared memory whether or not it is used,
and every live backend costs a few MB of private memory plus page tables. Under
the 4 GB cap that is worth reclaiming, but only after every pool is capped,
because a too-low `max_connections` turns a busy minute into refused logins.
The order:

1. Ship the pool defaults above and set `DB_POOL_MAX=4` on `boardsesh-web`.
2. Pin `DB_POOL_MAX=3` on the homelab sync daemons.
3. Watch the recount query below for a week of deploys. The peak, including a
   backend deploy, must stay under 45.
4. Only then set `max_connections = 60` (57 application slots). The deploy
   ceiling of 65 in the table is above 57, so either keep the background
   workers off, or put the backend behind PgBouncer first. PgBouncer's own
   cap of 45 servers must then drop to fit, for example 30 plus 5 reserve.

`max_connections` needs a restart, so it goes in a maintenance window. The
standby can keep 100: a hot standby needs a value at least as high as its
primary's, so lowering the primary is safe, and raising it again later means
raising the standby first.

### With PgBouncer

PgBouncer (#4842, above) takes up to 45 server connections, which leaves 52
direct slots at `max_connections = 100`. Behind it, web (4) and both backend
fleets (14 each, 28 during a deploy) are clients: 18 at steady state, 32 during
a backend deploy, sharing the same servers, so a deploy no longer moves the
database total. The direct clients (hold detector, homelab daemons and
workers, `boardsesh_readonly`, migrator) come to at most 39 with the defaults above.

The cost of the cap is queueing: a burst of long transactions makes the other
clients wait, and after 5 s they fail with `query_wait_timeout`. Watch
`cl_waiting` and `avg_wait_time` below after each cutover step.

### pg-boss timers

The backend is the only pg-boss owner with supervision and scheduling on
(`packages/backend/src/services/job-queue-client.ts`). Every replica runs the
timers, and each tick races the other replicas for the single
`pgboss.version` row. The defaults in pg-boss 12.33 cost about 830 s of
database time a day for a queue that runs about one job a minute, mostly as
row-lock waits (one 1-row UPDATE had a 10.9 s max). The backend sets:

| option                                 | pg-boss default | ours | why                                                                                                   |
| -------------------------------------- | --------------: | ---: | ----------------------------------------------------------------------------------------------------- |
| `flowIntervalSeconds`                  |             5 s | 3600 | flows and job dependencies are unused (`pgboss.job_dependency` is empty); lower it again to use them |
| `cronMonitorIntervalSeconds`           |            30 s |   45 | the maximum pg-boss accepts; 46 or more throws in the constructor                                   |
| `monitorIntervalSeconds`               |            60 s |  120 | the queue-stats pass seq-scans `pgboss.job_common`; expiry and heartbeat failures land 2 to 3 min late instead of 1 to 2 |
| maintenance `pollingIntervalSeconds`   |             2 s |   30 | reconcile crons get one job a minute; a dead-lettered detection is marked failed up to 30 s later |
| cron queues' `deleteAfterSeconds`      |          7 days |  1 day | `__pgboss__send-it` and both reconcile queues; the week of completed jobs was most of `job_common` |

`deleteAfterSeconds` is copied onto each job when it is inserted, so jobs
completed before the migrator applies the new value still age out on the old
7-day clock. `job_common` reaches its smaller size a week after the deploy.

The hold detector and the homelab workers run with supervision and scheduling
off, so only their fetch polls touch the database.

### Recounting

Recount with the query below before adding any direct client, raising a pool
size, or adding a PgBouncer replica.

```sql
SELECT usename, application_name, count(*)
FROM pg_stat_activity
WHERE backend_type = 'client backend'
GROUP BY 1, 2
ORDER BY 3 DESC;
```

### The startup rejection, and the driver patch that fixes it

postgres.js fetches array types on a connection's first ReadyForQuery, before it
sends the caller's statement. When PgBouncer times that fetch out, it sends a
FATAL `08P01` and closes. The stock 3.4.9 driver never handled the fetch's
promise (Node exits on the unhandled rejection unless something like Sentry
catches it), returned early from `closed()` without clearing the failed query,
and delivered the error to the caller only because the next socket's login
tripped over that stale state.

The workspace patch (`packages/db/patches/postgres@3.4.9.patch`, see #5299
above) now handles the fetch's promise. It fails the connect with the pooler's
error when the socket closes after an error during startup, and clears the
query state before any startup reconnect. The caller still gets `08P01
query_wait_timeout` for a statement that was never written, so the retry still
applies. `postgres-disconnect.test.ts` pins this against a fake PgBouncer on both
entry points: no unhandled rejection, one socket, the `08P01` error, one retry,
and the caller's statement written once.

### Deploy and cut over

1. Provision `MIGRATOR_DATABASE_URL`, `DATABASE_DIRECT_ENDPOINT`, the three
   distinct PgBouncer identities, TLS material and
   `PGBOUNCER_CUTOVER_SMOKE_TOKEN` before changing any runtime URL.
2. Verify the full-SHA image's GitHub attestation, resolve its OCI digest, and
   deploy that digest with the environment in `deploy/pgbouncer/README.md`.
3. Keep PgBouncer on the private network. Allow only the application services
   and an explicit operator source.
4. With `boardsesh-web` still direct, run the smoke below against
   `RAILWAY_WEB_ORIGIN` to record a baseline.
5. Change only `boardsesh-web`'s `DATABASE_URL` to the pooled private URL,
   redeploy the current image, then repeat the smoke against both
   `RAILWAY_WEB_ORIGIN` and `https://www.boardsesh.com`.

Load `PGBOUNCER_CUTOVER_SMOKE_TOKEN` from the same secret store as the target
service, then run:

```sh
vp run smoke:pgbouncer-cutover -- --origin https://TARGET
```

It requires zero failures from 100 climb renders and 100 uncached database
probes at concurrency 32. The probe route
(`/api/internal/pgbouncer-cutover-readiness`) is the only uncached read through
the web pool: climb pages come from `unstable_cache`, and `/api/health` never
touches the database. Use a dedicated high-entropy token, never a database
credential. Remove it from `boardsesh-web` after the cutover so the probe answers
401, and mint a fresh one for the next cutover.

Move the backend as a separate change, after the web cutover has run clean.

### Observe, alert, and roll back

Connect to PgBouncer's admin database (`pgbouncer`) with the admin identity:

```sql
SHOW POOLS;   -- cl_waiting > 0 for long = saturated; sv_* must sum to <= 45
SHOW STATS;   -- avg_wait_time rising = clients queueing for a server
SHOW CLIENTS;
SHOW SERVERS;
```

`sv_active + sv_idle + sv_used + sv_tested + sv_login` must stay at or below 45.
Success is zero smoke failures, zero PostgreSQL `53300` (too many connections)
events, and no more than 45 PgBouncer server connections.

Web Sentry events carry `postgres.error_code`; `53300` also carries
`postgres.resource_exhaustion:true`. Alert on at least one matching event in
5 minutes and require 30 clean minutes for recovery. The alert is configured by
hand because CI's Sentry access is read-only.

Roll back by restoring the direct `DATABASE_URL` on the service and redeploying.
Keep its pool knobs unchanged. Stop PgBouncer only after every service using its
URL has drained.

Rotate client credentials without an authentication gap: add a distinct
`PGBOUNCER_CLIENT_USER_NEXT` and password, deploy PgBouncer with both, move and
redeploy the clients, wait for old-identity traffic to reach zero, then promote
the next identity and remove the old one. Rotate the upstream and admin
identities separately, with a health check after each. Never use the PostgreSQL
superuser as the client or admin login.

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
  alertable endpoint, and since #4862 also the mobile app's reachability probe:
  the connectivity store hits it (5 s deadline, backoff ladder while
  unreachable) to confirm a suspected outage before showing "server trouble"
  — see `docs/offline-sync-plan.md` → "Backend reachability".

The probe (`packages/backend/src/services/db-health.ts`) runs `select 1` with a
5s result cache, single-flight dedupe, and a 2s deadline. When the deadline
wins it calls `query.cancel()`: postgres.js queues a query with no timeout of
its own (`postgres/src/index.js:341`), so walking away would leave a zombie
`select 1` that fires whenever the pool recovers, and probes would pile up
through an outage.

The same statement also reads `current_setting('max_parallel_workers_per_gather')`
and reports it as `database.maxParallelWorkersPerGather` — see the next section
for why. It rides the existing round trip rather than adding one.

## Parallel-query DSM exhaustion, and why the guard moved to the database (#5352)

`could not resize shared memory segment "/PostgreSQL.<id>" to <n> bytes: No space
left on device` (SQLSTATE `53100`, `dsm_impl.c` / `dsm_impl_posix`) is a
**parallel-query** failure. Postgres allocates a dynamic-shared-memory segment
per parallel worker out of the container's `/dev/shm`; Docker's default is 64 MB.
Measured on the dev catalogue (9.95M `board_climb_holds` rows), one `similarClimbs`
plan holds ~33 MB across 12 segments — so two concurrent parallel plans exhaust a
stock budget and the loser gets `53100`.

It is not a connectivity problem and a retry is not a fix: the statement reached
the server and the server refused it.

### Why five rounds of call-site guards did not end it

`withSerialPlan` (`packages/db/src/queries/util/serial-plan.ts`) opens a
transaction and issues `SET LOCAL max_parallel_workers_per_gather = 0`. Measured
under a deliberately shrunk `/dev/shm`, that guard is completely effective: the
unguarded statement raises `53100` and the guarded one returns normally. In Sentry
every guarded resolver went quiet the day its guard shipped —
`mySmartPlaylistCounts` after 2026-08-11, `similarClimbs` after 2026-08-15,
`syncClimbGrades` after 2026-08-18, `userTicks` after 2026-08-19.

What failed was the strategy, not the guard. The backend has roughly 65 statements
with the shape that Postgres can promote to a parallel plan (a join across two or
more of `board_climbs` / `board_climb_stats` / `board_climb_holds` /
`board_climb_grades` / `boardsesh_ticks`, or an aggregate over one). Four were
wrapped. Whether the planner picks a `Gather` for the other sixty changes as the
tables grow, so each round silenced one resolver and a different one surfaced
weeks later. The guard also never reached the sync daemons
(`recomputeClimbStatsBulk`), the board-snapshot export, SSR, OG-image data or the
scheduler jobs, all of which share the same `/dev/shm`.

### What we do instead

Migration `0225_dsm_serial_plan_default.sql` sets the default on the database:

```sql
ALTER DATABASE <db> SET max_parallel_workers_per_gather = 0;
```

Every session inherits it — resolvers, background jobs, scripts, a human in psql.
It is a **default, not a lock**: a session that wants parallelism can still
`SET LOCAL max_parallel_workers_per_gather = <n>` inside a transaction, and the
whole thing reverses with `ALTER DATABASE <db> RESET max_parallel_workers_per_gather`.
It cannot change results, only latency — and on the top offender the serial plan is
*faster* (2154 ms vs 4163 ms), because the parallel plan reaches for a Parallel Seq
Scan where the serial plan keeps the index.

Plain SQL against a stock `docker run postgres:17`: no Railway knob, no dashboard
setting, no extension. Database settings can travel in a portable dump: a plain
`pg_dump --create` includes them, and a custom archive restores them with
`pg_restore --create`. A restore into an existing database does not restore those
settings. A restored Drizzle ledger also prevents migration 0225 from rerunning;
follow the [restore verification gate](#preserving-the-default-through-a-database-restore)
before routing traffic to a restored database.

Two caveats worth knowing:

- **Existing pooled connections keep their old value until they cycle**
  (`idle_timeout` is 30s outside Vercel), so the change lands within about a minute
  of the migration rather than instantly.
- **The migration is fail-soft**, and in production that is the only path it ever
  takes. See below.

### Why the migration cannot apply in production (#5352 round 5b)

`ALTER DATABASE ... SET` requires ownership of the database. The production
migration session is deliberately the opposite of that: `production-deploy.yml`
connects as `boardsesh_migrator` and `SET ROLE`s to `boardsesh_owner`, and
`reserveMigrationOwnerSession` refuses to run a single statement unless
the owner role did not own the database (`packages/db/scripts/migration-owner-role.ts`).
The production investigation for #5372 found the `railway` database owned by
the Railway-provisioned superuser, without an owner-capable credential in CI.
That was the observed configuration, not a requirement on future credentials.

**Update, 25 Sep 2026:** the replication work transferred `railway` to
`boardsesh_owner`. `reserveMigrationOwnerSession` now accepts either layout —
a superuser-owned database with the single non-grantable owner `CREATE`, or
`boardsesh_owner` owning this database — and still rejects the owner role
owning any other database. The history below describes the earlier layout.

On its initial run under that role, 0225 raised `insufficient_privilege`. Its
`EXCEPTION` handler turned that into a `RAISE WARNING`, and drizzle recorded the
migration as applied, so later deploys do not retry it. Reproduced against a stock
`docker run postgres:17` wearing the same role shape:

```
WARNING:  boardsesh: could not set max_parallel_workers_per_gather on database
          railway; (must be owner of database railway)
-- pg_db_role_setting: 0 rows; a runtime session still reports 2
```

`ALTER ROLE <app_role> SET ...` — the pooled-URL escape hatch used for
`statement_timeout` above — is closed for the same reason: `permission denied to
alter role … Only roles with the CREATEROLE attribute and the ADMIN option on
role "boardsesh_runtime" may alter this role`.

Editing 0225 fixes nothing (it is already recorded), and granting the migration
role database ownership would dismantle the least-privilege contract the PG18
transition was built on. So the setting is owned by a **separate, idempotent
deploy step** instead:

```
vp run db:verify-serial-plan          # add -- --check-only to never write
```

`packages/db/scripts/verify-serial-plan.ts`, run by the `verify-serial-plan` job
after `migrate`:

1. Reads the setting through an ordinary **application** connection
   (`secrets.DATABASE_URL`, the runtime role). That is the fact that matters —
   what a new app session resolves the GUC to, the same number `/health/db`
   reports.
2. Exits 0 and issues nothing when it is already `0`.
3. Otherwise applies the database default when `ADMIN_DATABASE_URL` names a
   connection that owns the database, then re-checks on a **new** application
   connection (`ALTER DATABASE ... SET` never changes the session that issued
   it, so re-reading the same session would be a vacuous check). The ALTER
   targets the admin session's `current_database()`, so the step refuses before
   any DDL unless that equals the application session's database — an
   `ADMIN_DATABASE_URL` ending in `/postgres` fails the job instead of changing
   the maintenance database. It also compares the live server address, port,
   and postmaster start time before DDL, so another cluster with a database
   named `railway` fails closed. These values guard this run, not provide a
   durable cluster identifier. The application probe stays in its own open
   transaction while the admin probe, ALTER, and catalog recheck run in another.
   Transaction pooling therefore keeps both server identities pinned through
   the decision. If either connection path cannot expose a
   matching identity, use the one-off owner action below instead.
4. Otherwise **exits 1**, printing the one statement an operator runs once.

The automated ALTER and generated remediation accept simple ASCII database
identifiers (`[A-Za-z_][A-Za-z0-9_]*`), including the production name `railway`.
Names containing hyphens, spaces or non-ASCII characters receive a readable owner
handoff without generated SQL or an administrator connection. An operator must
handle those names with properly quoted SQL in a separately authorized owning
session. Connection-cleanup failures emit a warning while preserving the
verification result or original query error.

A **fresh database still gets the default from migrations**: 0225 applies
normally wherever the migrating role owns the database — local docker, the
`boardsesh-dev-db` image, CI service containers, branch deploys — which is every
environment except the production role shape. The deploy step is what covers that
one, and what makes a miss loud instead of a warning inside a 13k-line migration
log.

The job is deliberately **not** in the `needs:` of the deploy jobs. The condition
it reports is a property of the database, not of the commit being shipped, and a
deploy cannot fix it; gating the release train on it would trade a reported miss
for a self-inflicted outage. It is loud instead — a red job on every run plus the
Discord failure alert. The success notification also waits for this job and
is suppressed when verification fails or is cancelled; deploy jobs can still
complete while the workflow reports the database condition. See
[production deploys](production-deploy.md#serial-plan-verification-after-migrations)
for its environment and concurrency behavior.

**Operator handoff.** A green workflow requires the default to be applied. Before
rolling out verification, arrange either the one-off owner action below or the
owner-capable credential; otherwise every deploy reports verification failure
and sends the failure alert until the missing default is fixed. The credential
itself is optional because an already-correct database needs no administrator.

Database ownership is sufficient for this setting; use a dedicated database-owner
connection, not a cluster-superuser URL. Keep it separate from the restricted
migration and runtime credentials. A one-off owner session avoids retaining an
owner credential in the deployment environment.

When the deploy job goes red, either:

```sql
-- once, from a separately authorized psql session that owns the database
ALTER DATABASE railway SET max_parallel_workers_per_gather = 0;
```

or add `ADMIN_DATABASE_URL` to the `Production` environment pointing at such a
connection, and the job applies it itself on the next run. The setting survives
restarts on that database. A replacement database needs the restore verification
below. Confirm with `GET /health/db → database.maxParallelWorkersPerGather`,
which must read `"0"`.

### Preserving the default through a database restore

PostgreSQL's [pg_dump documentation](https://www.postgresql.org/docs/current/app-pgdump.html)
and [pg_restore documentation](https://www.postgresql.org/docs/current/app-pgrestore.html)
specify that `--create` includes database-level `ALTER DATABASE ... SET` settings.
For a full custom archive, use `pg_dump --format=custom` followed by
`pg_restore --create --exit-on-error` through an operator-provided account allowed
to create the target database. The restore connection selects a maintenance
database; PostgreSQL creates the database under the name stored in the archive.
The destination must not already have that name. Use a mode `0600` `PGPASSFILE`
and separate connection flags rather than putting passwords in command arguments.
Global roles still need separate provisioning; `--create` does not create them.

A restore into a precreated or renamed destination without `--create`, a
schema-only restore into an existing database, and logical replication need an
explicit target default. The [Neon migration runbook](neon-migration.md)
uses that path. The existing migration ledger is evidence of prior migration
execution, not evidence that the replacement database inherited its settings.

Before cutover, verify the **target** with application credentials:

```bash
# DATABASE_URL is injected for the target application role; no administrator is used.
vp exec pnpm --filter @boardsesh/db run db:verify-serial-plan -- --check-only
```

Do not route traffic to the target until this exits successfully and a fresh
application connection reports both the database default and effective value as
`0`. If it fails, an operator must apply the `ALTER DATABASE ... SET` above to the
target through an owning connection, or run the verifier with an explicitly
provided `ADMIN_DATABASE_URL` for that same target database, then repeat
`--check-only`. Recheck the target application's `/health/db` after its pooled
connections cycle. This is a database-migration cutover prerequisite; routine
deployments retain the separate, nonblocking verification job described above.

The integration suite exercises a real custom archive and both restore paths on
stock PostgreSQL 17: `--create` preserves the setting and the applied migration
ledger, while restoring into a precreated database fails verification until an
owning connection reapplies the default. CI uses the service container's matching
`pg_dump` and `pg_restore` clients via `SERIAL_PLAN_PG_CONTAINER`; local runs may
use installed clients compatible with `SERIAL_PLAN_DB_URL` instead.

### The recurrence signal

A warning in a migration log is exactly the kind of thing nobody reads, and five
rounds of this bug stayed invisible for want of a signal. So the backend reports
the value **its own pool actually sees**:

```
GET /health/db → database.maxParallelWorkersPerGather
```

`"0"` means the default landed. Anything else means it did not, and `53100` can
come back — read the `verify-serial-plan` job's log, which prints both the
session value and the database default and carries its own remediation. A value
present in `pg_db_role_setting` but not on the app's connections would be no fix
at all, which is why this reads the live session rather than the catalog.

The other half of the signal is Sentry: until #5351 every one of these landed in
the unfingerprinted `BOARDSESH-AK` bucket, which is why four "fixed" rounds looked
like one continuous failure. With per-cause fingerprinting a recurrence appears as
its own issue carrying the `graphqlPath` tag.

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
