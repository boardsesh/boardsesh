# Catalog rate limits

Catalog limits apply as soon as this code is deployed. There is no activation date,
application denylist, or native attestation requirement. Anonymous Expo web reads
remain available. The public [daily snapshot manifest](https://snapshots.boardsesh.com/board-snapshots/v1-gzip/manifest.json)
is the supported bulk bootstrap path; see [the dataset contract](../data/board-snapshots-dataset.md).

## Budgets

`packages/backend/src/utils/catalog-budget.ts` owns these fixed-window budgets.
HTTP and WebSocket operations share them across backend instances through Redis.
Changing an operation, filter, connection, or declared app identity does not reset
the allowance. Accounts share a generous IP backstop; unauthenticated guests at
one gym or carrier NAT share their IP allowance.

| Caller/lane | Work units/minute | Returned rows/hour | Returned rows/day | Active leases |
| --- | ---: | ---: | ---: | ---: |
| Anonymous interactive | 180 | 30,000 | 100,000 | 6 |
| Authenticated interactive | 180 | 100,000 | 500,000 | 6 |
| Authenticated board sync | 180 | 5,000,000 | 30,000,000 | 2 |
| Signed public web cache | 600 | 500,000 | 2,000,000 | 8 |

Most detail and sync reads cost one work unit. Search counts cost three; search
pages cost one plus an increasing charge for deeper pages. List queries with a
count cost four plus their depth charge; setter aggregates and heatmaps cost ten.
Existing per-operation limits still apply, now with distributed anonymous HTTP
enforcement and verified identity on both transports. Signed public cache work
receives five times the existing per-operation allowance, as well as the separate
shared catalog allowance above. It does not authenticate a user.

Rows are reserved before work starts and unused rows are refunded afterward.
Empty sync responses consume work, but no rows. Limits use fixed UTC minute,
hour and day windows; a boundary can allow two successive windows' allowances
close together. These are initial operating limits, not measured capacity claims.

An account has eight active leases across its lanes. Authenticated IP backstops
have 20 times the corresponding row/work allowance and 48 active leases. The
cluster allows 32 active catalog leases, including at most eight sync leases.
Leases expire after 120 seconds to recover from crashed processes; expiry does
not cancel SQL still executing, so this is not an absolute bound on queries that
run longer than the lease lifetime.

## Covered reads and compatibility

The shared GraphQL schema meters search rows, counts and `hasMore`, climb detail,
per-angle stats/grades, similar climbs, heatmaps, setter lists and aggregates,
user-created climbs, playlists, smart playlists, favorites, and the three full
board sync readers. Search admission wraps the lazy field resolvers that actually
perform work; aliases cannot bypass it or duplicate a single parent's read.

REST climb detail, setter lists and per-angle stats reserve through the backend
before resolving slugs or reading the database. Next signs each admission command
with a short-lived, purpose-specific HMAC derived from the existing shared
`NEXTAUTH_SECRET`. The proof binds the method, path, visitor identity and complete
command body. It is server-only, confers no account access, and never skips limits.
Redis stores release metadata, so a release on another replica remains idempotent.

Cached public SSR requests use a bounded service allowance and keep their cache
keys independent of visitors. They do not read request headers, preserving static
rendering. Uncached SSR requests carry signed visitor attribution. Neither browser
headers, app names nor user agents grant a larger allowance.

Native cold recovery and authored-row supplemental replay can still start from
the epoch. They use the separate sync allowance instead of the smaller interactive
row budget. Existing ownership/authentication checks stay in their resolvers.
User logbook synchronization, mutations and account-scoped post-write document
repair are outside this catalog budget; existing authorization and limits still
apply. These controls bound use, rather than prove which app a person runs or
prevent extraction through many accounts and networks.

## Failure behavior and operation

GraphQL returns `extensions.code = RATE_LIMITED`, `retryAfterSeconds`, the operation
and `snapshotManifestUrl`. REST returns HTTP 429 with `Retry-After` and non-cacheable
snapshot guidance. If the web server cannot reach admission or its server secret
is unavailable, REST returns non-cacheable 503 before doing catalog work. Deploy
the backend admission route before the web adapter, using the same existing secret.
Successful public responses retain their current cache behavior.

Redis calls have a deadline. During Redis outages, bounded local counters and
at most eight local active leases protect each process. These fallback allowances
are per process, not cluster-wide. Local observations and outage charges carry
forward conservatively on recovery, without reconstructing the exact sum of outage
usage across replicas; releases on other processes may leave local
shadows until expiry. Outage leases on other replicas can exceed the normal cluster
ceiling during recovery until those reads finish or their 120-second leases expire.
Memory is capped, and capacity exhaustion refuses admission.
No allowance is intentionally reset when Redis becomes unavailable.

Watch `RATE_LIMITED` responses, Redis fallback warnings, catalog query latency and
native recovery failures before tuning the constants. `CatalogRateLimitError.reason`
distinguishes work, rows, concurrency and local memory capacity. A larger limit
should follow observed legitimate usage. Do not grant exemptions based on an app
header, user agent, Origin or Referer.
