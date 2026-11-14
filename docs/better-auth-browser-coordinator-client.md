# Staged canonical browser coordinator

The shared auth protocol exposes four opt-in subpaths: `browser-coordinator`
for strict control metadata, `browser-coordinator-runner` for canonical lock and
network settlement, `browser-coordinator-channel` for www/app MessageChannel
clients, and `browser-coordinator-dom` for browser platform I/O. The WWW session
provider now has a canonical-frame preflight before its independent primary
session fetch. Its new source-owned readiness function remains literally false;
the public routes and frame perform no initialization in the shipped state.
Rollout ownership remains in #7430. Expo session-provider adoption is separate.

The locale-neutral `/auth/browser-coordinator` utility frame is noindex and stays
out of the sitemap. Its GET does not change locale or session cookies. Only that
exact path permits the exact configured HTTPS app origin as a frame ancestor;
other auth/account pages retain their existing frame-denying policy. The frame's
own layout skips session preflight/fetch so it cannot recursively create frames
or roll another legacy cookie. A cancelled metadata request retains the host
frame while its actual cookie request settles; document pagehide disposes it.

The canonical GET observe and POST initialize adapters project metadata only.
They require canonical Host and same-origin browser checks; POST accepts only
a bounded empty JSON object. Refused correlation, orphan proof material,
ambiguous legacy cookie families, and an unavailable authority never initialize
a replacement anonymous selection. Initialization reuses a positively admitted
existing selection without cookie writes. When there is an actual legacy JWE,
it is independently primary-admitted before a binding is created. Its exact
bytes become the version-one proof and backend login candidate: no new SID,
credential, authentication time, generation, or original expiry is issued.
Correlation, future proof cookies, whole next-request capacity and the complete
buffered success response are prepared before the backend selection CAS. An
unknown commit withholds all candidate headers and does not retry the mutation.

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

## Evidence and remaining composition

The local shared regression suite covers strict metadata, exact origin/source,
real MessagePorts, connection/request/operation mismatch, delayed older replies,
foreign bindings, teardown, timeout/abort settlement, read-before-retry,
truncated-body recovery and refused proof. Existing auth protocol tests also run.

The staged route tests exercise real JWE encoding/decoding, the actual primary
selection reader and proof-cookie codecs. The DOM tests use real MessagePorts
with injected Window/lock/network boundaries, including an abort-ignoring body
that must settle before the next lock owner dispatches. Mounted React tests
prove preflight ordering, unavailable initial identity and utility-frame
recursion refusal. These do not qualify real-browser cookie delivery.

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
