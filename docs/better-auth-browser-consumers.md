# Selected browser consumer staging

> **Superseded by #7596.** This describes the browser binding design, which is being removed. See [better-auth-browser-session.md](better-auth-browser-session.md). This file is deleted together with its code.

Epic #6975 rollout remains tracked in #7430. Public selected-browser consumer
readiness is a code-owned function returning `false`. An environment selector
cannot enable these public readers. Bootstrap, recovery, ordinary rolling
publication and whole-client/browser qualification remain open.

## Server facade

#7596 removed the selected server facade, its `/api/auth/*` response admission,
the ws-auth lease reply and the selected server-render branch. www reads only
the NextAuth session, and a leftover `__Host-boardsesh.browser-binding*` cookie
no longer turns those calls into a 503.

## Memory lease holder

The shared renderer-independent manager receives its fetch, monotonic clock and
timer from the platform. Bearers remain in its private memory. Subscriber
snapshots contain only owner/revision/lifecycle metadata; no bearer is stored in
IndexedDB, query persistence or a coordinator channel.

The owner includes UID, SID, generation and public binding ID/version. One
in-flight request serves that owner. Its whole monotonic roundtrip is debited
from the server's conservative usable duration. Timeouts abort and retire pending
work, including implementations that ignore abort, so a later request can
recover. Late results cannot replace a different owner or an A-to-B-to-A scope.

Confirmed denial or conflict invalidates old results. Uncertainty may retain
only an unexpired lease for the same owner; backend primary checks still apply.
Same-owner refresh does not extend an older result's own deadline. The original
returned result has a manager-owned WeakMap receipt. Consumers must call
`isCurrent(result)` after each await and immediately before attaching a bearer
or publishing a response/cache update. Copies and claimed metadata do not carry
that receipt.

## WWW client

#7596 removed the selected WWW client: the in-memory lease client, the
`graphql-request` receipt transport, the selected WebSocket controller, the
selected branch of the WebSocket token hook, and the session provider's
selected scope key and remount. WWW sends every HTTP and WebSocket request
through the session guard described in
[better-auth-browser-session.md](better-auth-browser-session.md), with the
NextAuth session it already used.

The selected private views for profile, statistics, profile sessions, gym
management and build-plan orders, and the selected profile JSON response, were
removed by #7596. Those pages and the profile endpoint render only through the
existing NextAuth session.

## Evidence and remaining work

The memory holder has 29 independently reviewed tests, including cached-positive
awaits, scope changes, exact expiry, copied results and bounded timeout recovery.
The server slice and its tests went with its code in #7596. The
separate backend PostgreSQL, restricted-role and real HTTP/WebSocket proofs do
not by themselves establish a joined public consumer qualification.

Expo-web consumers still require complete adoption of owner-bound results and
memory freshness. The actual cross-origin bootstrap, authenticated
distinct-binding controls, rolling-proof expiry, cookie-family GC,
supported-engine matrix and recovery protocol also remain required. The
readiness function stays false until the complete browser contract is reviewed
and qualified.

The first-observation gate recorded here for the WWW selected client went with
that client in #7596. Expo web's legacy-permitted dispatch keeps the same open
first-503 counterexample; see
[better-auth-browser-http-consumers.md](better-auth-browser-http-consumers.md).

The native OAuth callback decodes `getAdmittedRawServerToken()` as a NextAuth
JWE. Since #7596 that reader returns only the admitted NextAuth cookie, so no
backend lease reaches the callback. A backend delegation must never be decoded
or reused as a source credential.
