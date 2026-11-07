# BA-01 application-process persistence and rollback proof

This disposable proof supports [epic #6975](https://github.com/boardsesh/boardsesh/issues/6975)
and BA-01 (#6976). The [implementation ledger](./better-auth-implementation.md)
owns migration readiness. It does not install a production HTTP route, change
the active credential writer, or establish database crash durability.

## Real processes and a shared authority

The suite starts actual Node child processes with the installed `tsx` loader.
Their PIDs differ from the Vitest process and each other. Each child owns its
own Postgres connection pool, initializes the pinned Better Auth configuration,
and serves the real legacy and OAuth transaction wrappers through a loopback
HTTP socket. Requests use the canonical synthetic auth URL internally; this
fixture does not test HTTPS or browser cookie enforcement. The separate
[browser proof](./better-auth-implementation.md) covers that transport.

The test parent creates and migrates one owned `boardsesh_ba01_<random UUID>`
database. Children perform no schema generation or migrations and accept only
an explicit local URL with that exact generated-name shape. They reject remote
hosts, administrator/product database names and URL options, and do not inherit
`DATABASE_URL`, production keys or other account credentials. The worker refuses
to start without its test-owned IPC channel.

Requests cross process boundaries with real signed native JWTs and cookies from
the installed NextAuth 4.24.15 encoder. Two workers concurrently bridge the same
credential into one canonical session. After `SIGKILL` and replacement with a
new PID, that session remains usable and its unknown original authentication
age remains non-fresh. Sign-out tombstones, password-reset cutoffs and changed
passwords are checked through another process and again after replacement.
Cross-account canonical cookies cannot be overwritten by a stale legacy
credential, and an arbitrary body user ID is never accepted as ownership.

## A kill at the actual transaction boundary

The crash case does not infer rollback from a timer. A dedicated fault-mode
worker invokes the existing `afterPasswordMutation` callback after the real
Better Auth password update, reset-token consumption, revocation cutoff and
related lifecycle writes. The callback sends a fixed IPC barrier message and
waits before the outer Postgres transaction can commit. The parent first proves
that barrier was reached, then sends `SIGKILL` to that worker.

Its pending HTTP response fails. The surviving worker verifies the old password
still works; the parent verifies the original hash, unconsumed reset token and
absence of a committed cutoff. Retrying that same link succeeds. A further
process replacement then verifies the newly committed password works and the
old password fails. A separate injected exception proves that a provider's
translated HTTP 500 also rolls back before a replacement worker reads state.

This proves rollback when an application process disconnects during its open
transaction. Postgres remains running throughout. It does not prove a Postgres
crash, lost storage, a production restore, or a fleet-wide cutover/rollback.

## Bounded execution and cleanup

Readiness, requests, mutation barriers and process exits have explicit limits.
Workers bind only loopback on an ephemeral port. Cleanup terminates every owned
child and closes its database connections before the parent removes its owned
database. An unresponsive child receives a bounded forced-termination fallback.
Ownership starts immediately after forking, before readiness. Worker startup is
sequential, and a rejected startup is reaped before control returns to its
surviving siblings. Startup-error IPC is flushed with a bounded exit fallback.
IPC messages contain only fixed event types, PIDs and the ephemeral port; request
exceptions and child stderr are not copied into test output.

## Reproduce and recorded evidence

```sh
AUTH_PROTOTYPE_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:15475/postgres \
  vp test run --config packages/backend/vite.auth-prototype.config.ts \
  process-restart.test.ts --reporter=agent
```

On 2026-11-04 the author run passed **18 tests** in **28.73 seconds**, and an
independent security reviewer reran all **18 successfully** in **26.48 seconds**.
Both runs completed process and database teardown. The suite has eleven
real-process cases, including rejected-startup cleanup, and seven database-target
boundary cases. It covers both native JWT and NextAuth cookie transports.

Review found that parallel startup could let a slower sibling outlive cleanup
after another startup failed. Immediate ownership, sequential startup and the
new rejected-startup regression resolve that race. Review also requested flushing
startup-error IPC before exit; the final targeted regression verifies that
bounded path. The two source/test files pass `vp check` and backend TypeScript
checking. Author assertions alone do not close BA-01 or authorize production
cutover.
