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

Specialised error paths still call `Sentry.captureException` directly (`graphql/yoga.ts`, `websocket/setup.ts`, `handlers/sync.ts`, `index.ts`) — those exist to attach finer-grained tags or filter out noisy client-input `GraphQLError`s before capture. The winston transport is the default; direct capture is the exception.

### Dedup and DB-error masking

Two small helpers keep the direct-capture paths from double-reporting and from leaking SQL:

- **`utils/sentry-dedupe.ts`** — a resolver that captures a failure itself (e.g. `updateProfile`, `createSession`) calls `markErrorReported(err)`; the generic `graphql/yoga.ts` handler checks `wasErrorReported(err)` (which also inspects a `GraphQLError`'s `originalError`) and skips its own capture, so one failure yields one Sentry event. If you see a backend error reported exactly once with rich tags, that's this marker at work.
- **`graphql/mask-error.ts`** — in prod-like environments `graphql/yoga.ts` installs a targeted `maskError`. It sanitizes **only** raw database errors (drizzle's `Failed query: …` wrapper, or anything with a PostgresError code on its cause chain) into a generic `GraphQLError`, captures the real cause to Sentry (deduped as above), and passes every other error through unchanged. Global masking stays off so intentional `throw new Error(message)` resolver copy still reaches clients.

#### Why masked DB errors carry an explicit fingerprint

Every error the mask reports is a `PostgresError` raised from the same two frames inside `postgres.js`, so Sentry's default grouping — exception type plus stack — put **all** of them in one issue. That bucket (`BOARDSESH-AK`) held 34 distinct `(pgCode, resolver)` pairs when it was measured over 90 days: 585 events of `53100` (disk-full) next to 6 of `42703` (undefined column).

A mixed bucket does not just read badly, it reports every cause's impact as every other cause's impact. Sentry titles an issue from whichever sample event it picks, so this one was titled from a `42703` sample and triaged as **issue #4737: "presence_seq column missing, 32 users, P2"**. The 32 users were the disk-full failures; the six `42703` events were a single developer's local backend leaking as `environment: production`. Nothing was wrong with `presence_seq` in production.

So `maskDatabaseError` sets `fingerprint: ['graphql-yoga-mask', <SQLSTATE or driver code>, <schema field name>]`. A fingerprint decides **how many Sentry issues can exist**, so every component has to be bounded and server-controlled. Two things are deliberately kept out, both with tests in `mask-error.test.ts`:

- **The response path — this is the subtle one.** `GraphQLError.path` is built from *response keys*, which are the client's aliases: `query { zzArbitrary: gym }` produces the path `zzArbitrary` while the field is still `gym`. Keying on it would let anyone who can send a query mint unlimited issues by rotating aliases — fragmentation strictly worse than the single bucket this replaces. The identity comes from `error.nodes` instead, where the `FieldNode` keeps the schema name in `name.value` and the alias separately in `alias`.
- **The message.** It carries per-event noise (`could not resize shared memory segment "/PostgreSQL.523119486" to 1048576 bytes` differs every time), so grouping on it would trade one giant issue for thousands of singletons.

Because the key is a single schema field name, list indices never enter it — `userTicks.3.climb` and `userTicks.90.climb` are both just `climb`.

**Only the leaf field is available.** `maskError` is handed the error alone, with no `info`, so `parentType.name` cannot be included and two same-named fields on different types share one identity. That is a bounded, accepted imprecision; a client-controlled key is not an acceptable alternative. If you ever need `Query.board` precision, it has to come from an envelop hook that sees `info`, not from the error.

The two tags say different things and should not be confused:

| Tag | Meaning |
| --- | --- |
| `graphqlField` | The schema field that failed. The resolver identity, identical however the client aliased it. Group and search on this. |
| `graphqlResponsePath` | The alias-bearing response path, e.g. `myAlias.ticks.3.climb`. Locates the exact position in one event; never group on it. |

The older `graphqlPath` tag is gone: it read as a resolver name while carrying whatever the client called the field, which would mislead exactly the triage this fingerprint exists to enable.

Adding or changing this fingerprint splits existing issues: old events keep their grouping and new events land in fresh, per-cause issues. That is the intended one-off cost.

## Out of scope

- A request-id propagation layer is a separate concern (separate issue).
- Per-subsystem log-level matrices (e.g. promote `pubsub` to `debug` while leaving `events` at `info`) are not wired — set `LOG_LEVEL=debug` globally if you need that, or add a `child()` logger per subsystem when the need is real.
- Sentry breadcrumbs auto-generated from `console.*` no longer fire for backend log calls (we routed off console) — irrelevant now that the winston transport handles forwarding directly.
