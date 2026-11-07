# BA-01 HTTP and WebSocket revocation proof

This disposable proof supports [epic #6975](https://github.com/boardsesh/boardsesh/issues/6975)
and the session-security gate in [the migration design](./better-auth-migration.md).
The [implementation ledger](./better-auth-implementation.md) owns readiness. These
files do not register production routes or change the active credential writer.

## What crosses the network

`transport-revocation.test.ts` starts two independently initialized authorities,
each with its own Postgres pool and HTTP/WebSocket listener on an ephemeral
loopback port. Both use one test-owned database created and migrated by
`createPrototypeEnvironment`. These authorities run in the same Node process;
the separate [application-process proof](./better-auth-process-proof.md) covers
independent PIDs and application termination. No part of this transport suite
claims an operating-system or database crash.

Clients make actual HTTP requests and use the installed `ws` client against a
real `WebSocketServer`. HTTP sign-in runs the prototype native facade's real
credential path and returns a signed native JWT. WebSocket authentication checks
that JWT with the real canonical validator. Its minimal JSON protocol is local
test scaffolding, not GraphQL, `graphql-ws`, or a product router.

Each fixture accepts only an explicit local `boardsesh_ba01_<random UUID>`
database URL through the process proof's target validator. It has no
`DATABASE_URL` fallback and performs no DDL. Keys, users and passwords are
synthetic. Startup, requests, messages, ordering barriers and cleanup have
bounded waits. Cleanup terminates owned sockets, closes listeners and pools,
then removes the parent-owned database. A malformed raw WebSocket upgrade is
closed without crashing the listening authority.

## Per-operation policy and observable effects

A successful WebSocket authentication binds the presented token and canonical
user/session to that connection. It is not a positive authorization cache. Each
protected HTTP operation and each WebSocket command starts a fresh database
transaction, acquires the prototype's common advisory transaction fence, then
creates a transaction-bound `createPrototypeNativeFacade` with the fixture's
signing key and calls `validateAccessToken`. The validator checks signed claims
and current canonical session, user and revocation state. A client-supplied user
ID or replacement token cannot select another account.

The protected operation inserts a receipt in the disposable verification table
under a dedicated fixture prefix. Validation and that real database effect share
the transaction and fence used by lifecycle mutations. The test verifies receipt
ownership and persisted counts, rather than inferring success from a frame.
A trusted fault hook runs after the insert and before commit; throwing there
leaves no receipt, and a healthy authority can retry the same operation. These
receipts are evidence scaffolding, not a production command or idempotency design.

Password reset uses the actual legacy-handler wrapper through the other
authority's HTTP listener. Account sign-out uses the actual native revocation
facade through that listener. After either mutation acknowledges its commit, an
already authenticated socket's next command is denied and closed with `4401`;
neither authority accepts the old bearer over HTTP. The JWT's cryptographic
signature and expiry still pass, proving that canonical state causes rejection.
An idle socket is not proactively disconnected; it loses authorization at its
next protected command.

Closing only one authority's owned database pool makes its real revocation
reads unavailable. It returns HTTP `503` and WebSocket `UNAVAILABLE`/`1013`,
writes no receipt, and cannot authenticate a new socket. The sibling authority
continues working. A new pool accepts the unchanged valid credential again;
the availability fault does not create a cutoff or turn a retryable failure
into invalid credentials. This is a disconnected-pool fault, not a Postgres
server-outage experiment.

Legacy credentials with unknown original authentication age can still perform
ordinary commands after bridging. Their canonical session keeps its epoch
creation time and their native JWT has no `auth_time`; sensitive session-list
access still requires a fresh login.

## Ordering and the in-flight limit

The suite drives both deterministic database orders. A command that already
holds the common fence may commit its authorized receipt before a reset that
has arrived at the sibling listener. The reset then commits and the next
command fails. If reset commits before the command validates, no receipt is
created. The global advisory fence is a bounded prototype correctness policy;
this proof does not establish production throughput or a per-user lock design.

Network publication is separate from commit. A dedicated barrier pauses a
successful response after its receipt commits, completes reset through the
sibling, then releases that earlier response. The old success can therefore
arrive after the reset acknowledgment. Its next command is rejected. The proof
does not promise that revocation recalls committed effects, bytes already sent,
in-flight authorized replies, or subscription events. Subscription emission
authorization needs its own product policy and integration proof.

For the two uncomplicated reset/sign-out cases, the suite measures elapsed time
from receipt of the mutation's HTTP acknowledgment through the denied reply to
an immediately submitted command. That includes a local JWT signature check
and normal socket scheduling. The enforced test deadline is 10 seconds; this
local observation is not a production latency bound or an idle-socket deadline.

## Product integration remains BA-04 work

The current product paths remain unchanged. `packages/backend/src/middleware/auth.ts`
caches successful legacy validations for 60 seconds.
`packages/backend/src/websocket/setup.ts` authenticates in `onConnect` and returns
stored connection context for later GraphQL operations. The local fixture's
fresh canonical check, common transaction fence, failure handling and lack of a
positive cache do not apply to those paths merely because this suite passes.
The [WebSocket architecture](./websocket-implementation.md) and BA-04 integration
must adopt and verify the chosen revocation policy for actual resolvers,
subscriptions, caches and multiple production instances. Browser TLS, cookie,
CORS, Redis publication and frontend reconnect behavior are also outside this
proof.

## Reproduce and recorded evidence

```sh
AUTH_PROTOTYPE_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:15475/postgres \
  vp test run --config packages/backend/vite.auth-prototype.config.ts \
  transport-revocation.test.ts --reporter=agent
```

On 2026-11-04 the author run passed **16 tests** in **4.79 seconds**, including
complete socket, listener, pool and database teardown. The two local
acknowledgment-to-denied-reply observations were **14.34–19.36 milliseconds**.
Adding `--reporter=verbose` prints these observations alongside the agent report.
These figures describe this local run, not a service-level guarantee.

An independent reviewer reran all **16 transport cases** alongside the canonical
generation, native and bridge suites: **61 tests passed in 6.64 seconds** with
clean teardown. Their two acknowledgment-to-denied-reply observations were
**8.62–11.51 milliseconds**. Independent source review found no remaining
transport issue after the fixes below.

The source and test files pass `vp check` and backend TypeScript checking.
Independent review identified an uncaught
malformed-upgrade URL and a rollback fault injected before its claimed write.
The fixture now catches and closes malformed upgrade peers, and the failure hook
runs after the receipt insert but before transaction commit. Regressions cover
both fixes; the reviewer rechecked their source and the bounded cleanup paths.
