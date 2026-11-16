# Staged canonical browser coordinator

> **Superseded by #7596.** This describes the browser binding design, which is being removed. See [better-auth-browser-session.md](better-auth-browser-session.md). This file is deleted together with its code.

The shared auth protocol exposes four opt-in subpaths: `browser-coordinator`
for strict control metadata, `browser-coordinator-runner` for canonical lock and
network settlement, `browser-coordinator-channel` for www/app MessageChannel
clients, and `browser-coordinator-dom` for browser platform I/O.

#7596 deleted the www half: the `/auth/browser-coordinator` utility frame, its
frameable header rule and middleware carve-out, the `observe` and `initialize`
routes under `/api/internal/auth/browser-coordinator`, and the session
provider's preflight. It was dark in production because its readiness gate
returned `false`, but the URLs were live: the frame page answered 200, its page
component rendered nothing inside the site layout, `app.boardsesh.com` was
allowed to frame it, and the two routes answered 503. All three now answer
404, and the frame path gets the site-wide
`X-Frame-Options: SAMEORIGIN` headers like any other page.

One caller is left in the shared package. Expo web's
`coordinateExpoBrowserSession`
(`packages/mobile/src/lib/browser-coordinator-client.web.ts`), behind its own
hard-false gate, imports `requireCoordinatorOrigin` from `browser-coordinator`
and the frame client `createCanonicalBrowserCoordinatorFrame` from
`browser-coordinator-dom`, which connects through the channel client. That
frame client loads the frame path, which is now a 404. The rest has no caller:
the host half `mountCanonicalBrowserCoordinator`, the runner, the channel
endpoint, `connectCanonicalBrowserCoordinator`, and the code that fetches
`observe`, `initialize` and `renew`. The deleted www page was the only thing
that mounted the host. Nothing imports the `browser-coordinator-runner` or
`browser-coordinator-channel` subpaths directly. This file goes with the
shared subpaths.

Messages contain only connection/request UUIDs, typed control operations and a
binding digest/version cursor. They carry no password, UID/SID, authentication
age, JWE, canonical token, intent secret, session projection or arbitrary fetch
URL. Strict schemas refuse additional fields rather than forwarding them. A
`ready` result is coordination metadata and cannot authenticate a user.

The caller injects platform I/O. The canonical endpoint must verify both exact
HTTPS origin and exact source window before taking its single transferred port.
Each subsequent request/reply binds the connection, request ID and operation.
The client rejects lower versions and unexpected binding changes; different
binding recovery is a separate authority-qualified operation. Connections,
active requests and replay history are bounded. At the 256-request connection
lifetime the client explicitly closes; `isClosed()` requires a new handshake
and fresh primary read, never new binding initialization merely to reconnect.
Closing or timing out a client
cancels pending work and ignores later metadata replies.

The runner owns the common canonical-www exclusive lock through network
settlement. Its injected lock adapter must use the shared exported lock name at
that canonical origin; a per-frame queue is not a cross-origin coordinator.
Transport receives `credentials:include`, `cache:no-store`, `keepalive:false`
and an AbortSignal. A deadline aborts but does not release the lock until the
actual transport promise settles. This deliberately avoids `Promise.race`
releasing a lock while an earlier response can still install a cookie.

A read observes before initialization. Initialization has no default transport;
missing binding without an injected initializer is unavailable. If headers
installed a cookie but the body failed, the next read observes and reuses it.
Preheader loss can retry normally; there is no permanent pending marker or
credential persistence. A present proof-required selection never triggers
initialization or legacy fallback. Initialization always gets a confirmation
read; blocked cookies return unavailable without a loop.

Preparation and renewal carry only an expected cursor. A completion with a
different binding/version is a conflict. Those operations do not transport a
mutation capability or authorize cookie publication; the backend still needs
current presented proof, selected-authority receipt, operation-bound intent and
same-transaction mutation/publication checks. Future same-selection renewal
must preserve original age, UID/SID, generation, credential kind and provenance.

#7596 deleted renewal custody: the www `renew/{prepare,commit}` routes and the
backend renewal authority are gone. Expo web's frame client still sends a
`renew` message, but no host page answers it now, so it reports unavailable.
The host code that would fetch the two renew routes has no caller.

## Evidence

The local shared regression suite covers strict metadata, exact origin/source,
real MessagePorts, connection/request/operation mismatch, delayed older replies,
foreign bindings, teardown, timeout/abort settlement, read-before-retry,
truncated-body recovery and refused proof. Existing auth protocol tests also run.

The DOM tests use real MessagePorts with injected Window/lock/network
boundaries, including an abort-ignoring body that must settle before the next
lock owner dispatches. These do not qualify real-browser cookie delivery.

Separate owned Chromium151 HTTPS transport experiments cover nine cases each
on HTTP/1.1 and HTTP/2: abort, same-origin and sibling-origin navigation, iframe
removal, page close and preheader failure preserve a newer cookie; a body
failure after headers reuses the installed cookie. Live-request and
keepalive-unload controls reproduce the stale-cookie overwrite. These
experiments do not qualify the mounted application. WebKit was not installed.

No authentication safety is inferred from a message, lock, unavailable result
or metadata cursor alone.
