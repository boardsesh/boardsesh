# Unmounted browser coordinator client

The shared auth protocol exposes three opt-in subpaths: `browser-coordinator`
for strict control metadata, `browser-coordinator-runner` for canonical lock and
network settlement, and `browser-coordinator-channel` for www/app MessageChannel
clients and the unmounted receiving endpoint. No product imports these modules,
no backend URL is selected, and no public route or bootstrap gate is enabled.
Rollout ownership remains in #7430.

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
active requests and replay history are bounded. At the256-request connection
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

## Evidence and remaining composition

The local shared regression suite covers strict metadata, exact origin/source,
real MessagePorts, connection/request/operation mismatch, delayed older replies,
foreign bindings, teardown, timeout/abort settlement, read-before-retry,
truncated-body recovery and refused proof. Existing auth protocol tests also run.

Separate owned Chromium151 HTTPS transport experiments cover nine cases each
on HTTP/1.1 and HTTP/2: abort, same-origin and sibling-origin navigation, iframe
removal, page close and preheader failure preserve a newer cookie; a body
failure after headers reuses the installed cookie. Live-request and
keepalive-unload controls reproduce the stale-cookie overwrite. These
experiments do not qualify the mounted application. WebKit was not installed.

Public bootstrap still requires the supported-browser cancellation proof with
two fully authenticated distinct bindings, not only anonymous-cookie values.
The backend stable binding must remain correlation only, with actual
current-version proof possession required everywhere. Versioned proof cookies,
exact observed-name/chunk cleanup, same-selection rolling expiry, usable
missing-proof/account-switch recovery, primary SSR/ws/session reader adoption
and the original actual-consumer response-order matrix remain separate gates.
No authentication safety is inferred from a message, lock, unavailable result
or metadata cursor alone.
