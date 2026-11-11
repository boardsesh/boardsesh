# Database connectivity: connect retries and health probes

How Boardsesh survives a Postgres connect blip, what it deliberately does not
retry, and where to point a monitor.

## TLS verification

The shared primary and replica pools honor explicit `sslmode=verify-full`:
both certificate trust and hostname are checked, including for local hosts.
An explicit `verify-full` request is never replaced by the legacy `require`
default. Remote URLs without `verify-full` retain the existing
encryption-only default; this change does not migrate other deployments' trust.
That includes `verify-ca`: use `verify-full` when certificate verification is required.
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

A streamed query can deliver rows before failing or losing its socket. The
connection must reset its row offset whenever it discards that result, including
`ReadyForQuery` after an error and both reconnect paths. Otherwise the next
successful query starts at the old offset and returns a sparse array. JSON
caching turns its holes into `null`, which caused climb-page metadata consumers
to fail (#6112). The recovery suite sends a partial row followed by an error or
disconnect, then verifies dense results on the reused or replacement connection
through both entry points. The climb stats reader also removes nullish entries
after its cache boundary so previously stored results remain readable.

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

The wait between attempts is a ref'd timer. A process that only awaits a
retrying statement (worker startup, before its health server listens) would
otherwise exit 0 mid-retry with no log (#6703).

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
| `DB_POOL_MAX`             | 5 (Vercel: 3)  | postgres.js `max`, clamped to a floor of 2 and, with a warning, a ceiling of 100        |
| `DB_POOL_IDLE_TIMEOUT_S`  | 30 (Vercel: 5) | seconds an idle connection is held open; `0` means "never close one" and is not clamped  |
| `DB_STATEMENT_TIMEOUT_MS` | unset          | emits a `statement_timeout` startup parameter — **off by default**, see the hazard below |
| `DB_IDLE_IN_TRANSACTION_TIMEOUT_MS` | unset (60000 in the backend server and the web server) | emits an `idle_in_transaction_session_timeout` startup parameter: 1000 to 2147483647 ms, or `0` for off; any other value stops the process at boot. See "Idle transactions end after 60 s on request pools" below |

6000 sits deliberately below `DB_CONNECT_RETRY_BUDGET_MS` (10000): during a
brownout the front door should shed load rather than spend a second and third
connect attempt holding a pool slot while a crawler waits. That comparison only
holds because the budget is per request — see the shared-budget note above.

The pool knobs default to `max` 5 and idle 30 s (the previous `max` default
was 10) — except on Vercel, where an unset knob falls back to the serverless
pair (`max` 3, idle 5 s; `process.env.VERCEL` selects it, an explicit env var still wins).
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
  Production's `boardsesh-backend` and `boardsesh-web` connect directly and
  take `45000`; the sync daemons do not get it (see "Runaway guards" in
  [railway-cost-reduction.md](./railway-cost-reduction.md)).
- **Pooled (PgBouncer) URL** — do it database-side instead, with
  `ALTER ROLE <app_role> SET statement_timeout = '8s'`, which passes through a
  pooler transparently.

Every production URL is direct today ("PgBouncer: parked" below). Do not use
`SHOW pool_mode` on the application database to tell them apart: PgBouncer
forwards it to PostgreSQL there. Check the host and port in the URL instead.

### There is no web health probe

`/health` and `/health/db` below are **backend** endpoints. `packages/web` has
none, so during a web-pool incident `/health/db` stays green and says nothing
about the surface that is actually failing. That gap is not filled here.

## Idle transactions end after 60 s on request pools

The partner logbook feed serves only changes below the oldest write
transaction still open, cluster-wide ([integration-platform.md](./integration-platform.md),
"Incremental sync"). One session left idle inside a transaction holds every
app's feed back until it ends. Before this, ending such sessions was an owner
step (`ALTER ROLE ... SET idle_in_transaction_session_timeout`), which the
migration role cannot run ("Why the migration cannot apply in production" below).
It is now a startup parameter on the pools that serve requests.

### Which pools send it

`applyRequestPoolDefaults()` (`packages/db/src/client/postgres.ts`) sets
`DB_IDLE_IN_TRANSACTION_TIMEOUT_MS` to 60000 unless it is already set, so every
postgres.js pool the process builds afterwards sends
`idle_in_transaction_session_timeout`. Two processes call it, before their first pool:

| process | where | pools covered |
| --- | --- | --- |
| backend HTTP/GraphQL server | `src/index.ts` imports `src/request-pool-defaults.ts` straight after `./instrument` | shared primary, read replica, admission pool (60 s); partner and logbook snapshot pools (10 s, see below); a `createDedicatedPool` added later inherits 60 s unless it passes its own value |
| web server | `app/lib/db/db.ts`, the only module that builds the web's pools | shared primary and read replica |

The partner and logbook snapshot pools pass 10 s (`partnerPoolOverrides()`), the
same limit partner transactions and snapshot chunk transactions already set for
themselves with `set_config(..., true)`, so a transaction opened on those pools any
other way gets it too. A transaction-local `set_config` always beats the startup
parameter.

The backend server also runs pg-boss consumers in the same process (push
delivery, spray detection and background-job maintenance, the popularity, grade
summary and popular-config refreshes, PostHog person deletion). They use the same
`db` pool, so they are covered too.

If the import order is ever wrong, the process will not start:
`applyRequestPoolDefaults()` throws when a shared pool was already built without
the setting, instead of letting the server run uncovered. The one process that
loads backend and web code together, the App Router test harness
(`app-router-harness.ts`), sets `DB_IDLE_IN_TRANSACTION_TIMEOUT_MS=0` for that reason.

### What is not covered, and why

| pool | why it is left at the server default (off) |
| --- | --- |
| background workers (`workers/index.ts`) | `export-board-snapshots` holds one REPEATABLE READ transaction for the whole export while it writes SQLite between cursor batches |
| Aurora and Kilter sync daemons, hold detector | own processes and own pools; the daemons are disabled in production since the routine cutover |
| pg-boss pools | the `pg` driver, configured in `job-queue-client.ts`; worker pools already carry `statement_timeout` and `query_timeout` (#6683) |
| migrations (`packages/db/scripts/migrate.ts`), `drizzle-kit`, every script | one-off processes that never call `applyRequestPoolDefaults()`; the MoonBoard catalog import holds a session advisory lock on one connection for its whole run |
| `boardsesh_readonly` | people and dashboards, outside the app |

Those can still hold the feed back, so the alert on the oldest running write
transaction ([integration-platform.md](./integration-platform.md),
"Observability") stays.

### Why 60 s

The timeout ends only a session that sits idle inside an open transaction: the
transaction has sent a statement, got the answer, and the app has not sent the
next one. A long statement is not idle (`statement_timeout` bounds those), and a
connection idle between transactions is not affected. So what matters is the
longest the app can await something else while a transaction is open.

An audit of every transaction reachable from the backend server and the web
server on 2026-11-10 found these, longest first:

| path | what the transaction waits on | bound |
| --- | --- | --- |
| `getStoredKilterAccessToken` (`kilter-sync/src/api/stored-token.ts`), called by the backend's Kilter live sync | the Keycloak refresh, with the credential row `FOR UPDATE` | 30 s (`AbortSignal.timeout` in `keycloak.ts`) |
| push delivery (`spray-detection-notifications.ts`) | a second transaction on another pool connection, then the Expo push call | 15 s for the push, plus the pool and wall-lock wait |
| `updateSessionBoardPathIfChanged` (`session-discovery.ts`) | Redis reads, with the `sessions` row `FOR UPDATE` | milliseconds; none while Redis stalls |
| Kilter live import (`kilter-live-import.ts`) | two Redis reads | 1 s each |
| `boss.send` inside a transaction | pg-boss's queue cache on its own pool, only for a queue created after boot | 10 s connect timeout |

Every web transaction is database-only. 30 s would race the Keycloak refresh: if
Keycloak rotates the refresh token and the session ends before the new token is
written, the stored token is dead and the climber has to relink Kilter. 60 s is
twice that bound. Going higher only lengthens how long one stuck session holds
every partner's feed and its row locks. The two waits with no bound of their own,
a stalled Redis and an exhausted pool, are cases where ending the session is the
better outcome: each holds a row or advisory lock that other requests queue behind.

A new transaction that awaits a network call must stay well under 60 s, or move
the call out of the transaction.

### What an affected request sees

Postgres logs `FATAL: terminating connection due to idle-in-transaction timeout`
(SQLSTATE 25P03) and closes the socket. Nothing in that transaction commits. No
statement is in flight, so the driver reports `CONNECTION_CLOSED`, and the
patched driver ("Socket disconnects and transaction cleanup" above) rejects the
transaction the moment the socket closes, not on its next statement. That is not
retried ("What is NOT retried" above). GraphQL counts it as a database outage and
answers HTTP 503 (`isDatabaseUnavailableCode` in `graphql/mask-error.ts`); the
mobile app then probes `/health/db`, which stays green. The pool opens a fresh
connection for the next caller, so only the request that idled fails.

The transaction's callback is not stopped. It finishes whatever it was awaiting,
and every statement it sends after that is rejected, but work outside the
database still happens. The one place that matters today is push delivery: if
its inner transaction waits past the timeout for a pool slot or the wall lock,
the job fails and is retried, the Expo push it then sends still goes out, and the
ticket write is rejected, so the retry sends that push a second time. That needs
the inner wait and the push together to pass 60 s (the push is capped at 15 s).
Both sends carry the delivery's `collapseId` and `tag`, so the phone replaces the
first notification with the second rather than showing two.

`packages/backend/src/__tests__/idle-in-transaction-timeout.test.ts` checks this
against the test Postgres: a covered pool loses the session after a 1 s timeout
and the next statement fails with `CONNECTION_CLOSED` while the pool keeps
serving, the transaction settles before its callback's wait ends, and the
callback's next statement is rejected; an uncovered pool's transaction survives
the same idle time; a fresh
process that imports `request-pool-defaults.ts` reports `1min`, and one that does
not reports `0`.

### Changing it

Set `DB_IDLE_IN_TRANSACTION_TIMEOUT_MS` on the Railway service (`boardsesh-backend`
or `boardsesh-web`). It takes whole milliseconds from 1000 to 2147483647, which
replace 60000, or `0`. Unset or empty gets the 60 s default. Anything else stops
the process at boot with a message naming the variable: `60` would be 60 ms and
end nearly every transaction, `99999999999` is past PostgreSQL's ceiling and
would fail every connection, and `60s` has no reading worth guessing. A variable
change redeploys the service; connections opened before it keep their old value
until they close, which a deploy does.

`0` turns off the process-wide 60 s, and only that. It sends no parameter, so:

- the partner and logbook snapshot pools still send 10 s (`partnerPoolOverrides()`
  does not read the variable), and their transactions still set 10 s with
  `set_config(..., true)`;
- a role-level `ALTER ROLE ... SET idle_in_transaction_session_timeout` from
  earlier would apply again. None should exist (see the check in
  [integration-platform.md](./integration-platform.md), "Idle transactions").

Do not put `idle_in_transaction_session_timeout` in `DATABASE_URL` or
`READ_REPLICA_URL`: postgres.js lets a URL parameter beat the option on the
shared pools. The startup parameter has the PgBouncer hazard described for
`statement_timeout` above, on the replica URL as much as the primary: behind a
transaction-mode pooler, move it onto the role instead.

## Admission reads have their own pool

Every authenticated request reads the primary to learn whether the account
still exists (#7350), with a 1,000 ms deadline. The statement is cheap: 115,616
executions with a 13.7 ms maximum in `pg_stat_statements`. The wait was never
the statement. It queued in the same 5-connection pool per replica as search
and count transactions that run 3–26 s (`withSerialPlan` holds a connection for
the whole transaction), and because `prepare: false` keeps parameterised
queries from pipelining, it waited in the driver's FIFO behind them. When the
pool stayed full for a second the climber got a 503 instead of a slow 200.

Admission reads now run on `createDedicatedPool` (`auth/admission-pool.ts`), two
connections per backend replica, used for nothing else:

- **Primary, never a replica.** A lagging read must not decide admission.
- **Lazy.** Connected on the first read. Workers, the scheduler and `packages/web`
  never run one, so they pay nothing (`workers/index.ts` does not even import the path).
- **`statement_timeout` of 1,000 ms**, set as a startup parameter on this pool only
  (`application_name` is `boardsesh-auth-admission`, so the connection-count query
  below sees it). It replaces `DB_STATEMENT_TIMEOUT_MS`, which is 45 s on the backend,
  and it also beats a `statement_timeout` or `application_name` in `DATABASE_URL`:
  postgres.js lets URL parameters win over options, so `createDedicatedPool` drops
  the ones its caller overrides from that pool's URL and leaves the rest. The clock
  starts when the statement reaches the server, so a read that queued first can
  outlast its caller's deadline by as long as it queued; the timeout bounds how long
  a connection is held, not how long a caller waits. It has the same PgBouncer hazard
  as that knob ("The `statement_timeout` hazard" above): if a transaction-mode pooler
  ever fronts the backend, this pool must keep a direct URL or move the timeout onto
  a role.
- **A watchdog on each read, at 2,000 ms.** The statement timeout needs a server that
  is still answering, and `max: 2` stops a third connection opening. A read with no
  reply this long after reaching a connection fails. If no other read on the pool has
  answered since it began, the pool is severed and replaced. If one has, the stalled
  read may be waiting on a slow dial: postgres.js opens the second connection only
  when the first is busy, so that read outlives the watchdog while the first
  connection keeps answering, and severing then would cut both. A dial settles
  within the connect timeout plus the statement timeout, so the read gets until 7 s
  (4 + 1 + 2 s to spare). Still unsettled then, it is on a dead socket beside a
  healthy one, and the pool is replaced with 1 s of grace so reads on the healthy
  connection finish. Before that rule a pool with one frozen connection kept it for
  good: at a 400 ms statement, 20.7% of requests failed and the pool was never
  replaced. Now it is replaced at 7.0 s, and nothing fails after 10 s. An event-loop
  stall of 2 s or more can also fire the watchdog; that costs one reconnect, and
  those reads were past their deadline anyway.
- **Replacements back off: 5 s, then 10 s, then 20 s** between them for as long as
  reads keep stalling. The schedule starts again at 5 s only after a whole gap with
  no stalled read. An answered read does not restart it, and neither does a
  connection that opens: a server whose new connections answer for a moment and
  then hang does both, and restarting on answers kept the gap at 5 s there (7
  replacements in 40 s, 16 backends on the server). Now it is 4 replacements at 2.5,
  8.8, 19.0 and 39.0 s, with 10 backends. Each replacement can leave two hung
  backends until they die; at a fixed 5 s gap one replica left 22 in a minute, and
  two replicas at that rate would fill the roughly 28 free slots in about 40 s, after
  which every client's reconnect fails with `53300`. 20 s is the cap because it is
  also the longest a path that has healed can wait behind a pool that hung before it
  healed: a 60 s step refused every request for 50.1 s after such a heal, and the
  cap brings that to 10.1 s, at most 20 s plus the watchdog.
- **`connect_timeout` of 4 s**, against the shared 30 s. It has to be longer than the
  watchdog, or a primary that takes more than 2 s to open a connection can never be
  reached: at 2 s, 492 of 492 requests failed for as long as opens were slow. It has
  to be shorter than the first 5 s gap between replacements, so a dial ends before
  the next replacement could cut it off. The cost is the other side of the same
  number: a dial swallowed by a dead path holds its slot for up to 4 s after the path
  heals. It is passed to `createDedicatedPool`, because postgres.js copies it when it
  builds each connection and writing `pool.options` afterwards has no effect.
- **A dial that timed out is not retried.** `withConnectRetry` gets a 1,000 ms budget
  on this pool, the caller's deadline: a refused or unresolved connect, which fails
  in milliseconds, is still retried while the caller waits, but a timed-out dial is
  already past the deadline and a retry only adds dials to a struggling primary.
- **Closed last in graceful shutdown**, after the main pools, bounded at 2 s.

Before and after with the main pool held full by five transactions: the same
read through the main pool misses every time at 1,001–1,003 ms; through its own
pool it answers in a median of 0.7 ms, 20.9 ms at worst, over 500 reads.

Recovery from a lost path, measured at 30 requests/s against the test Postgres
through a TCP proxy:

| fault | before the watchdog and connect timeout | now |
| --- | --- | --- |
| `SIGSTOP` on both admission backends, Postgres otherwise healthy | every request failed for the full 75 s measured | last failure 2.0 s after the stop |
| both connections severed and new connections swallowed for 5 s | every request failed for 25.0 s after the path healed | last failure 1.0 s after it healed |
| both connections severed and every new connection taking 2.5 s to open, for 18 s | every request failed while opens stayed slow, 492 of 492 (with a 2 s `connect_timeout`) | first success 4.6 s in, no failures after 4.1 s |
| the same with 3.5 s opens | not measured | first success 5.6 s in, no failures after 5.1 s |

The `connect_timeout` choice, measured with the same three faults:

| `connect_timeout` | 2.5 s opens | 3.5 s opens | black hole, last failure after heal |
| --- | --- | --- | --- |
| 3 s | served from 4.6 s | failed until the opens sped up | 0.03 s |
| 4 s | served from 4.6 s | served from 5.6 s | 1.0 s |
| 5 s | served from 4.6 s | served from 5.6 s | not clean: the test process paused during that run |

The black-hole number depends on where in its timeout the swallowed dial was when
the path healed, so the worst case is the `connect_timeout` itself.

### The read returns generations too (BA-04 PR 2)

The same statement now also selects `auth_subject_cutoffs.generation` and
`native_generation` from the row it already joined for `deleted_at`, so readers
can decide credential cutoffs (docs/better-auth-migration.md, "Credential
cutoffs"). Still one statement per coalesced read: the mounted test counts one
admission-pool statement and no main-pool select for one validation, and one
for a same-tick burst of 80 validations across 40 accounts.

Measured on the local test Postgres with 10,000 users, 4,000 interleaved runs of
each exact statement on one connection, `prepare: false` (milliseconds,
median / p99):

| cutoff rows | users per read | before | after |
| --- | ---: | ---: | ---: |
| none (production today) | 1 | 0.237 / 0.435 | 0.240 / 0.406 |
| none | 128 | 1.011 / 1.276 | 1.026 / 1.296 |
| 5% of accounts | 1 | 0.231 / 0.278 | 0.233 / 0.284 |
| 5% of accounts | 128 | 1.015 / 1.350 | 1.028 / 1.359 |

`EXPLAIN (ANALYZE, BUFFERS)` gives the same plan and the same shared-buffer hits
before and after in all four cells (3, 164, 6 and 173).

### How much can queue on two connections

At most two coalesced reads and one sweep batch compete for the two connections
(`MAX_CONCURRENT_COALESCED_ADMISSION_READS` 2, `MAX_SWEEP_BATCHES_PER_ROUND` 1;
`MAX_UNSETTLED_AUTH_ADMISSION_READS` stays 8). Coalesced callers past the two reads
wait in the coalescer, where one that outlives the deadline is refused before any
read starts, instead of queueing on a connection and using up the deadline there.

When four coalesced reads and up to four sweep batches shared the two connections,
75.6% of requests failed at a 250 ms statement with a 4-batch sweep, and 92.9% at
400 ms with a 1-batch sweep. Failure rate at 30 requests/s now, 8 s per cell,
statement timed with `pg_sleep`:

| statement | one sweep batch per second | no sweep |
| --- | --- | --- |
| 100 ms | 0% | not run |
| 250 ms | 0% | 0% |
| 400 ms | 0% | 0% |
| 500 ms | 0% | 0% |
| 800 ms | 79.6% | 0% |

The longest statement seen in production is 13.7 ms.

**The sweep takes one second per 128 connected users on a replica**, because a round
is one batch and rounds are a second apart: 1,280 users were all reached in 10.0 s
(8 s for 1,000, 40 s for 5,000). A failed read still leaves the socket open.

### The admission read log

Reads queue in front of the driver rather than inside it, so `waitMs` is exact.
`auth/admission-read-diagnostics.ts` writes only what a 503 needs explained, at
`warn`, with numbers and fixed labels and never a user ID, email or token:

| `outcome`         | when                                      |
| ----------------- | ----------------------------------------- |
| `slow`            | answered, in 250 ms or more               |
| `deadline_missed` | no answer before the 1,000 ms deadline    |
| `failed`          | the read itself errored (`errorCode`)     |
| `refused`         | all eight read slots were taken           |

`waitMs` is time before the read got a connection, `executeMs` is time on one,
including opening it when none was open. The line for a read that missed the
deadline is written at the deadline, with the numbers so far. `executeMs: 0` at
`waitMs: 1000` means it never reached a connection; `waitMs: 2` at `executeMs: 998`
means the statement itself, or the path to Postgres, took the second.

Each kind logs once per 10 s window with a totals line (`suppressedReads`,
`maxWaitMs`, `maxExecuteMs`) when the window saw more, so a stall costs at most
two lines per kind per window per replica. Read it for the bursts that were
never explained: if they continue, this line says whether the wait was here or
on the server. If they stop, the main pool was the cause.

A pool replaced by the watchdog logs `[auth-admission] replaced the pool after a
read stopped answering`, one line per replacement.

### Dedicated pools

Every `createDedicatedPool` caller, and what it costs. A new one adds a row here and
a row to the budget table in "Pool budgets and pg-boss timers" below. Its steady cost
is 2 × its size (two backend replicas) and 4 × its size while an old fleet drains.

| pool | connections per replica | opens | budget row |
| --- | --- | --- | --- |
| `auth/admission-pool.ts` (`boardsesh-auth-admission`) | 2 | first admission read | "backend admission pool" |

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
  currently use). They do take their pool size from the shared
  `resolvePoolMax()`, so `DB_POOL_MAX` caps them.

## PgBouncer: parked

**Status: parked 2026-09-26, never deployed.** Every client connects straight to the PG18 primary.

- **Why it was built:** Vercel serverless fan-out, where every function instance
  opened its own pool (#4842, #4861).
- **Why it is parked:** www now runs as one Railway container. Production holds
  about 50 of the 97 connections open to application roles, and Sentry shows
  zero `53300` (too many connections) errors since the PG18 cutover on 2026-09-20.
- **What remains:** the postgres.js driver patch for a FATAL during startup
  (next section), the `postgres.error_code` Sentry tags on web, and the
  migration direct-endpoint guard ([production-deploy.md](./production-deploy.md)).
- **Full design:** PR #4849, merge commit `2d22fb8d4`, image
  `ghcr.io/boardsesh/boardsesh-pgbouncer@sha256:efde5a9496817cc3be00383ca741681d74f44ab7c08bc8fd7b6ecd71db105918`.
- **Revisit when:** the first `53300` lands in Sentry, steady client connections
  pass 75, or the backend wants `overlapSeconds`.

Count connections before and after any pool change:

```sql
SELECT usename, application_name, count(*)
FROM pg_stat_activity
WHERE backend_type = 'client backend'
GROUP BY 1, 2
ORDER BY 3 DESC;
```

## Pool budgets and pg-boss timers (C15)

The following are projections after the code defaults in this change are
deployed. They are not a live production measurement. The web service currently
sets `DB_POOL_MAX=10` explicitly, so the new default does not affect it until
the separate operator cap is applied. The Aurora and Kilter sync runners build
their own postgres.js pools rather than calling `createDb()`, and size them with
the same `resolvePoolMax()` (`packages/db/src/client/postgres.ts`): 5 when
`DB_POOL_MAX` is unset, the variable when it is set, never below 2 or above 100. Capping the
daemons at 3 is therefore a variable change, with no code change. The hold
detector's `createDb()` pool uses the shared default of 5 (or honors an
explicit `DB_POOL_MAX`), and its separate pg-boss pool is fixed at 3. No
three-connection hold-detector override is part of these source defaults, so
the projection below counts both pools as 5 + 3. (The homelab compose in
blackheathdc-ansible, `roles/boardsesh_detector`, sets `DB_POOL_MAX: "3"`, so
the detector holds 3 + 3 there.)

| client                                   | code defaults (web still 10) | after web cap 4 | after web cap 4 and daemon cap 3 |
| ---------------------------------------- | ---------------------------: | --------------: | --------------------------: |
| backend postgres.js, 2 replicas          |                       2 x 5 |          2 x 5 |                      2 x 5 |
| backend admission pool, 2 replicas       |                       2 x 2 |          2 x 2 |                      2 x 2 |
| backend partner OAuth pool, 2 replicas   |                       2 x 3 |          2 x 3 |                      2 x 3 |
| backend logbook snapshot pool, 2 replicas |                      2 x 2 |          2 x 2 |                      2 x 2 |
| backend pg-boss, 2 replicas              |                       2 x 2 |          2 x 2 |                      2 x 2 |
| web postgres.js (explicit env)           |                          10 |             4 |                         4 |
| hold detector                            |                           8 |             8 |                         8 |
| sync daemons, about 3                    |                       3 x 5 |          3 x 5 |                      3 x 3 |
| background workers, 4 roles              |                   4 x (2+1) |      4 x (2+1) |                  4 x (2+1) |
| `boardsesh_readonly` (role cap)          |                         <=5 |           <=5 |                       <=5 |
| migrator, during a deploy                |                           1 |             1 |                         1 |
| **steady ceiling (one migrator counted)**|                     **<=79** |       **<=73** |                   **<=67** |
| **+ old backend fleet draining (15 s)**  |                    **<=107** |      **<=101** |                   **<=95** |

The code-only budget uses the unchanged web setting of 10. Both caps are
operator steps, and each is one variable:

| service | where it runs | variable | value |
| --- | --- | --- | --- |
| `boardsesh-web` | Railway, production environment | `DB_POOL_MAX` | `4` |
| `kilter-sync` and `aurora-sync` daemons | homelab host `boardsesh-sync`, docker compose, not Railway | `DB_POOL_MAX` in `sync.env` (blackheathdc-ansible `roles/boardsesh_sync/templates/sync.env.j2`) | `3` |

The two daemon containers share that one `env_file`, so one line caps both.
The daemon cap takes effect once the host runs a `boardsesh-sync` image built
from this change or later; an older image ignores the variable. The daemon row
counts three pools, which is conservative: the sync host runs two daemon
containers, and production has had both disabled since the routine cutover
(`boardsesh_sync_daemon_disabled: true`, see
[background-workers.md](./background-workers.md), "Routine cutover"), so they exit
before opening a pool. The row matters again if that cutover is rolled back. The
admission pool adds 2 per backend replica, 4 at steady state and 8 while an old
fleet drains ("Admission reads have their own pool" above); production had 43
of 100 in use when it was added. Do not lower `max_connections` to 60 while the
drain projection is 75 or higher (95 with partner OAuth on): 60 leaves 57
application slots, below even the later-cap projection. The original C15 order still applies — cap every
client, watch a week of deploy peaks under 45, then consider the restart-window
change. If those conditions are not met, keep `max_connections=100`.

### Dedicated pools

Every `createDedicatedPool` caller, and what it costs. A new one adds a row here and
a row to the budget table above. Its steady cost is 2 × its size (two backend
replicas) and 4 × its size while an old fleet drains. Both partner pools are built
only when `PARTNER_OAUTH_MODE` is not `off`, and postgres.js connects on first use,
so with the mode `off`, the default, neither costs anything.

| pool | connections per replica | opens | steady / draining |
| --- | --- | --- | --- |
| `auth/partner/authority.ts` (`PARTNER_POOL_MAX`) | 3 | first partner OAuth or `/v1` request | 6 / 12 |
| `auth/partner/logbook-access.ts` (`LOGBOOK_SNAPSHOT_POOL_MAX`) | 2 | first logbook snapshot start, build or page read | 4 / 8 |

The partner OAuth pool serves the OAuth routes and the `/v1` API together,
including logbook feed pages and single ticks, which are short indexed reads run
inside the `/v1` admission permit the token check already holds.

The logbook snapshot pool (L4) keeps the bootstrap's build off every other pool:
a fully cold build chunk can take the whole 5 s statement timeout. Two connections
per replica, because one may build and one serves snapshot starts and page reads,
so a build never queues a page read. The two cluster-wide build slots
(`LOGBOOK_SNAPSHOT_BUILD_SLOTS`) still both get used, one per replica. A request
never waits for a build permit (it answers an empty page instead), and a start or
page read waits at most 1 s in a queue of 8, then answers `503`.

With partner OAuth on, the two pools add 10 at steady state and 20 while a fleet
drains, so with the mode `off` every total above is that much lower: 69 and 87 at
code defaults. The table above already counts the auth admission pool (2 per
replica, #7381), so the drain is 107 at code defaults, 101 with the web cap to 4
and 95 with the daemon cap to 3.

Against the 97 application slots, and an admission connection refused with
`53300` is not retried. Before leaving mode `off`, do one of these: apply both
the web cap to 4 and the daemon cap to 3 (drain 95), or lower
`LOGBOOK_SNAPSHOT_POOL_MAX` to 1 (drain 97 with only the web cap: then a cold
build on a replica makes that replica's snapshot page reads wait, and answer
`503` after 1 s), or lower `PARTNER_POOL_MAX` to 2 (another 4 off the drain, but
the authorize, `/v1` and token lanes then share two connections), or raise
`max_connections`. The two pool sizes are code constants, not settings:
`LOGBOOK_SNAPSHOT_POOL_MAX` in `packages/backend/src/auth/partner/logbook-access.ts`
and `PARTNER_POOL_MAX` in `packages/backend/src/auth/partner/transaction.ts`, so
either option is a source change and a deploy, not an operator step. The drain-97
option uses every one of the 97 application slots and leaves no headroom, so
prefer the drain-95 option or raising `max_connections`.

### If PgBouncer is revisited

PgBouncer remains parked as described above. If the backend and web are later
moved behind its 45-server cap, the code defaults make them 18 clients at
steady state (web 4 plus backend 14) or 32 during a backend deploy, plus 10 and 20
with partner OAuth on (its two dedicated pools). The direct
clients (hold detector, sync daemons, background workers, the backend's two
admission pools, `boardsesh_readonly`, and migrator) total at most 45 while the
daemons remain at 5, and 39 with `DB_POOL_MAX=3` on the daemons. This projected split fits under the 97 application slots; it
is not evidence that PgBouncer has been deployed or that its TLS prerequisites
are complete.

### pg-boss timers

Only the backend owns pg-boss supervision and scheduling. Its replicas contend
on the same `pgboss.version` row; the installed defaults perform frequent
timer updates even when queues have little work. The C15 defaults are:

| option                               | pg-boss default | this change | effect |
| ------------------------------------ | --------------: | ----------: | ------ |
| `flowIntervalSeconds`                | 5 s             | 3600 s      | Flows and job dependencies are unused; restore a short interval before adding either. |
| `cronMonitorIntervalSeconds`         | 30 s            | 45 s        | 45 s is the maximum accepted by pg-boss 12.33; 46 throws during construction. |
| `monitorIntervalSeconds`             | 60 s            | 120 s       | The 60 s supervise cadence makes expiry and missed-heartbeat checks 2–3 min instead of 1–2. |
| maintenance `pollingIntervalSeconds` | 2 s             | 30 s        | Reconcile and dead-letter workers poll less often, with at most one-minute scheduling. |
| selected cron retention              | 7 days          | 1 day       | Applies only to `__pgboss__send-it` and the spray/background-job reconcile queues. |

The backend maintenance consumers set only their polling interval and therefore
keep pg-boss 12.33's defaults of one local worker and a batch size of one. The
hold-detector queue consumer sets both values to one explicitly. Slowing the
maintenance polling does not change worker concurrency or batch size.

The owner migrator updates retention on installed queues. pg-boss copies
`deleteAfterSeconds` onto each job when it is inserted, so already-completed
jobs keep the previous seven-day clock. The popular-config and climb-popularity
queues keep their existing schedules and retention policies.

### A FATAL during startup, and the driver patch that handles it

postgres.js fetches array types on a connection's first ReadyForQuery, before it
sends the caller's statement. When the server answers that fetch with a FATAL
and closes (found against PgBouncer's `query_wait_timeout`, but any server that
ends a session during startup takes the same path), the stock 3.4.9 driver never handled the
fetch's promise (Node exits on the unhandled rejection unless something like
Sentry catches it), returned early from `closed()` without clearing the failed
query, and delivered the error to the caller only because the next socket's
login tripped over that stale state.

The workspace patch (`packages/db/patches/postgres@3.4.9.patch`, see #5299
above) handles the fetch's promise, fails the connect with the server's error
when the socket closes after an error during startup, and clears the query state
before any startup reconnect. `postgres-disconnect.test.ts` pins this on both
entry points against a fake server that sends a FATAL during startup: no
unhandled rejection, one socket, the server's error, and the caller's statement
written once.

### Worker job-queue read deadline (#6683)

A background worker's pg-boss pool has exactly one connection (`PGBOSS_POOL_SIZE=1`).
In pg-boss 12.33, pg 8.23 and pg-pool 3.14, nothing ever takes back a connection
that is checked out:

- pg-pool's `connectionTimeoutMillis` covers only callers waiting for a
  connection and new connects (`pg-pool/index.js`, `connect()` and `newClient()`).
- Its idle timer starts only on release.
- pg has no read deadline (`query_timeout: false` in `pg/lib/defaults.js`) and no
  keepalive by default.

So a query that is sent and acknowledged but never answered holds the only slot
for good. A TCP proxy whose upstream leg has gone does exactly that, and
keepalive cannot see it, because the proxy answers the probes itself. Every
later checkout then fails with `timeout exceeded when trying to connect`. That
is the line two homelab workers logged once a minute for three days, from
pg-boss's 60 s queue-cache refresh.

`createJobQueueClient` therefore sets `query_timeout`
(`WORKER_JOB_QUEUE_QUERY_TIMEOUT_MS`, 30 s) on worker-owned pools. pg-boss
passes its config through to `pg.Pool` and each `pg.Client`. When the deadline
fires:

1. pg rejects the query with `Query read timeout`, which our diagnostics call
   `failure: 'query_timeout'`.
2. pg-pool discards the client.
3. `client.end()` destroys the socket, because a query is still active.

`job-queue-dead-socket.test.ts` reproduces it with a fake server that swallows
a query on an open socket.

**Giving up tells the server nothing, so the server gets a shorter deadline.**
A statement the client abandons keeps running on the server. A backend waiting
on a lock never looks at its socket while `client_connection_check_interval` is
0, the default. Once the lock clears, an abandoned `fetch` commits and activates
a job no worker receives. Meanwhile the poll loop has sent its next fetch, 2 s
later on a fresh connection, and that one can activate a different job.

So worker pools also set `statement_timeout`
(`WORKER_JOB_QUEUE_STATEMENT_TIMEOUT_MS`, 25 s). pg sends it as a startup
parameter (`getStartupConf` in `pg/lib/client.js`). A server that is alive but
slow, or stuck behind a lock, cancels the statement at 25 s and rolls it back
(SQLSTATE 57014) before the client's 30 s deadline. Nothing commits behind the
worker's back, and the connection stays usable. The 30 s `query_timeout` only
fires when the server has gone silent.
`job-queue-server-deadline.test.ts` holds an advisory lock against a real
server and checks that the blocked statement is cancelled and never commits.

The startup parameter needs a direct connection to Postgres. Every client,
workers included, connects straight to the primary, because PgBouncer was never
deployed ("PgBouncer: parked" above). A worker's TLS is verified against our own
CA, whose leaf names only `pgdr.boardsesh.com` and the Railway-internal host
(`docs/pg-primary-tls-rollout.md`), so nothing in between terminates the
session. If a pooler is ever put in front of the workers, move the deadline onto
the worker logins with `ALTER ROLE <worker login> SET statement_timeout = '25s'`.
PgBouncer rejects any startup parameter that is not in
`ignore_startup_parameters`, so every worker connection would fail.

**What a lost fetch costs.** Nothing runs twice: run I/O (`touch`, `complete`,
`fail`, `send`) never touches this pool, because it goes through the Drizzle
adapter on the application pool. The only write here is `fetch`. A fetch whose
answer was lost on a silent connection may still have activated a job. The
backend supervisor fails that job once its heartbeat window passes, which takes
30–900 s depending on the family, plus up to 1–3 min for the supervise pass. Until
then the job holds its `stately` singleton key. pg-boss retries it as a new
attempt with its own claim if the family has retries left; that uses one. A
family with `retryLimit: 0` loses that run outright. `provider-routine-cycle` is
one; its next cycle, five minutes later, covers it.

**The backend's pool has neither deadline.** Its supervision and maintenance
passes, such as the queue-stats pass that seq-scans `pgboss.job_common`, can
legitimately run longer than 30 s.

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
