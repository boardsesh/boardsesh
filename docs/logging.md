# Backend Logging

The backend uses [winston](https://github.com/winstonjs/winston) for structured logging. There is one singleton logger at `packages/backend/src/utils/logger.ts`; all backend code calls `logger.info` / `logger.warn` / `logger.error` rather than `console.*`. The lint rule `no-console` is set to `error` for `packages/backend/src/**/*.ts` (configured under `lint.overrides` in the root `vite.config.ts`), so reintroducing `console.*` fails CI. Test files keep the global allow list for `warn`/`error`/`info` since test infra uses console for orchestration.

## Output formats

The logger picks its format from `NODE_ENV`:

- **Development** (`NODE_ENV !== 'production'`): one line per event, colorized, in the shape
  `[i:abcd1234] [info] message {…fields}`. The leading `[i:abcd1234]` tag is the first 8 chars of the pubsub instance UUID — the same prefix style the previous `installInstanceLogTag` console-patch produced, so existing grep workflows keep working. When the backend runs without Redis (local-only mode) there is no instance id and the prefix is omitted.
- **Production**: JSON, one object per line. Each event includes `level`, `message`, `timestamp`, `service: "backend"`, `pid`, and (when set) `instanceId`. JSON is the lowest-common-denominator format that works on Railway, plain Docker, and any successor host — staying portable is a goal from `CLAUDE.md`.

`error` and `warn` events go to `stderr`; `info` and `debug` go to `stdout`. This intentionally follows Node's `console.error` / `console.warn` stream behavior while keeping lower-severity logs on stdout. `debug` only emits when `LOG_LEVEL=debug`.

Operational note: configure log collection to ingest both stdout and stderr. Docker, Railway, and most drains can display a combined view, but a collector that tails only stdout will miss warnings and errors.

## Configuration

- `LOG_LEVEL` — minimum level emitted (`error`, `warn`, `info`, `debug`). Defaults to `info`. Set `LOG_LEVEL=debug` to raise verbosity for a single subsystem investigation without a deploy.
- `NODE_ENV` — selects dev vs prod format as described above.

The logger never reads any Railway-specific env var. If you need to ship logs somewhere else, point the host's log aggregator at the backend's stdout/stderr.

## Instance ID wiring

The `instanceId` field comes from `pubsub.getInstanceId()`, which is itself populated from the Redis adapter's `uuidv4()` at Redis-connect time. The logger module knows nothing about pubsub directly — `server.ts` calls `setInstanceIdProvider(() => pubsub.getInstanceId())` immediately after `await pubsub.initialize()`. The provider is read at log time, so:

- Log calls before pubsub init have no `instanceId` — usually only the very first `instrument.ts` / Sentry startup is in that window.
- Log calls after pubsub init read the current id.
- In local-only / no-Redis mode the provider returns `null` and the prefix / field is omitted.

This indirection also keeps the logger module free of project imports, so `pubsub`, `redis-adapter`, and friends can import the logger without creating a cycle.

## Spying on the logger in tests

After the migration the previous `vi.spyOn(console, 'error')` calls no longer capture anything (winston writes via `process.stdout.write`, not `console.*`). To suppress / assert log output in a test:

```ts
import { logger } from '../utils/logger';

const errSpy = vi.spyOn(logger, 'error').mockImplementation(() => logger);
// …run code under test…
expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('expected message'));
errSpy.mockRestore();
```

The `() => logger` return matches winston's method signature (each level method returns the logger instance for chaining).

## Why winston (and not Pino / native console / pretty-printed wrapper)

- The previous global `console.*` patch (`installInstanceLogTag`) leaked the instance prefix into every third-party library's output. Replacing it with a structured logger gives us per-call control without monkey-patching.
- Winston was chosen over Pino for its mature format-combine API — the `instanceIdFormat` step uses a closure to read the provider at log time, which avoids the alternative of mutating `defaultMeta` from `server.ts` and depending on import-evaluation order.
- The dev format intentionally mirrors the old console-patch output (`[i:abcd1234] ` prefix) so grep / tail workflows don't change.

## Sentry forwarding

`logger.error(message, err)` automatically forwards to `Sentry.captureException` via `SentryWinstonTransport` (`packages/backend/src/utils/sentry-transport.ts`), which is attached alongside the Console transport in `createBackendLogger`. The captured event carries `tags: { source: 'winston-logger' }`, the log message as `extra.logMessage`, and the current `instanceId` when present.

Two rules to remember when adding an `error` log:

- **Pass the underlying `Error` as the trailing arg.** `logger.error('Auth check failed:', err)` reaches Sentry. `logger.error('Auth check failed')` does not — message-only error logs are intentionally skipped to keep Sentry quiet, since most are operational status lines. Wrap raw strings in `new Error(...)` if you want them captured.
- **`logger.warn` is never forwarded.** Use `logger.error` (with an `Error`) for events that should page; keep `logger.warn` for noisy operational lines (origin rejections, retry counters, etc.).

The transport is gated to prod-like environments (`!isLocalDevelopment() && !isTestEnvironment()`, from `@boardsesh/db/client/config`), matching the same gate on `Sentry.init({ enabled })` in `instrument.ts`, so dev and test runs do not emit Sentry events even when an `Error` is attached. This is deliberately **not** a bare `NODE_ENV === 'production'` check: the Railway backend deploy leaves `NODE_ENV` unset, so the old equality gate silently disabled Sentry in production (issues #3603 / #3183).

Specialised error paths still call `Sentry.captureException` directly (`graphql/yoga.ts`, `websocket/setup.ts`, `handlers/sync.ts`, `index.ts`, `services/github-mirror-report.ts`) — those exist to attach finer-grained tags or filter out noisy client-input `GraphQLError`s before capture. The winston transport is the default; direct capture is the exception.

`services/github-mirror-report.ts` is the pattern to copy when a failure needs per-event context. It pairs a **message-only** `logger.error` (which the transport deliberately skips) with its own `Sentry.withScope` capture, so the event carries the row that was lost and the user whose write it was — a `logger.error(msg, err)` there would file a second, poorer copy of the same failure.

### Dedup and DB-error masking

Two small helpers keep the direct-capture paths from double-reporting and from leaking SQL:

- **`utils/sentry-dedupe.ts`** — a resolver that captures a failure itself (e.g. `updateProfile`, `createSession`) calls `markErrorReported(err)`; the generic `graphql/yoga.ts` handler checks `wasErrorReported(err)` (which also inspects a `GraphQLError`'s `originalError`) and skips its own capture, so one failure yields one Sentry event. If you see a backend error reported exactly once with rich tags, that's this marker at work.
- **`graphql/mask-error.ts`** — in prod-like environments `graphql/yoga.ts` installs a targeted `maskError`. It sanitizes **only** raw database errors (drizzle's `Failed query: …` wrapper, or anything with a PostgresError code on its cause chain) into a generic `GraphQLError`, captures the real cause to Sentry (deduped as above), and passes every other error through unchanged. Global masking stays off so intentional `throw new Error(message)` resolver copy still reaches clients.

## Backend memory samples

Every backend instance emits `event: "backend.memory"` once per 60 seconds.
Samples include release, deployment/replica identity, uptime, process memory in
bytes (`rss`, `heapUsed`, `heapTotal`, `external`, `arrayBuffers`), connection
and pubsub counts, room/grace-timer/pending-write counts, metadata and geometry
cache sizes, renderer cache/queue statistics, and Sharp cache/task counters.
The timer is unref'd and is cleared during server shutdown. Samples contain
counts rather than tokens, user IDs, URLs, or cached payloads.

`memory.peakRssBytes` is the process-lifetime RSS high-water mark from
[`process.resourceUsage().maxRSS`](https://nodejs.org/api/process.html#processresourceusage),
converted from KiB to bytes. It preserves short spikes between samples if the
process survives to emit another sample; it resets on process restart. Do not
sum replica peaks as though they occurred simultaneously, or treat a lifetime
peak as current usage. A process killed before its next sample may lose the
last spike's telemetry.

`arrayBuffers` is included in `external`; do not sum them. RSS also includes
native allocations and is not equivalent to live JavaScript heap. Serialized
metadata-cache weights bound retained payloads but do not measure V8 overhead.
Instagram and TikTok each retain at most 1,000 entries and 4 MiB of serialized
keys/payloads. Their existing 10-minute success and 2-minute transient-error
TTLs remain; the sampler also sweeps expired entries while traffic is idle.

Compare replicas with the same release, uptime, and workload before aggregating
service memory. For the reported growth within hours, compare 24 hours before
and after rollout at the same replica count. Track connection/subscriber counts
after disconnects and empty rooms after their 60-second grace window. A low
cold-start reading alone does not establish a fix. Keep renderer budgets and
replica counts fixed during the comparison; correlate continued RSS growth
with heap, external memory, render jobs, and Sharp task counts before tuning.
The reported 30-day history includes spikes near 12 GB, whereas the last seven
days stayed near or below 3 GB. Treat these as separate windows: correlate peak
timestamps with releases, restarts, replica count, rendering, uploads, and bulk
imports/exports. Seven quieter days do not establish that a leak is fixed.
Heavy bot traffic was blocked during this period, making request-driven work
and cache growth important leads rather than confirmed causes. Compare request
volume and endpoint mix as well as uptime; bots can also amplify retention
bugs. Without matching traffic, lower post-rollout memory alone is inconclusive.

The local reconnect soak (`vp exec node --expose-gc --import tsx
scripts/backend-memory-churn.ts 1800`) exercises active and quiet subscriptions
for 30 minutes, asserting channel counts return to zero and sampling memory
each minute. Forced GC is diagnostic-only; it is never used in production.
This test covers subscription retention, not a full backend traffic workload.

## Out of scope

- A request-id propagation layer is a separate concern (separate issue).
- Per-subsystem log-level matrices (e.g. promote `pubsub` to `debug` while leaving `events` at `info`) are not wired — set `LOG_LEVEL=debug` globally if you need that, or add a `child()` logger per subsystem when the need is real.
- Sentry breadcrumbs auto-generated from `console.*` no longer fire for backend log calls (we routed off console) — irrelevant now that the winston transport handles forwarding directly.
