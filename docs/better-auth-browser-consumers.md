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

## Dark WWW client adoption

The selected WWW branch uses the same public owner tuple for session context,
lease acquisition and client intent scopes. An original live manager result is
registered in a bounded private token registry. A token-taking HTTP or WebSocket
client captures an opaque WeakMap scope once; ordinary reconnects may acquire a
new lease only for that same owner and revision. A-to-B-to-A transitions retire
the original client even if account metadata later matches again. Invented
metadata, copied results and unregistered bearer strings cannot create scopes.

Selected uncertainty is distinct from positively confirmed anonymity. Invalid
selection metadata, a missing marker after selection or unavailable readiness
cannot turn an authenticated null-token dispatch into an anonymous request.
Only a successful central anonymous session restores that dispatch. Intentionally
public HTTP reads that omit authentication remain public; recognized selected
bearers and stale legacy authenticated headers never fall through.

The HTTP adapter checks immediately before sending, after response headers and
after graphql-request completes its actual body parsing. Each concurrent
response retains its own original lease receipt. Responses that cross an owner
change or outlive the presented lease are discarded. An uncertain mutation is
never automatically replayed.

The WebSocket adapter rechecks queued frames synchronously at `send` and checks
each subscription delivery. It requests a same-owner renewal before expiry.
An expired lease's 4401 becomes retryable only after a new actual lease is
admitted; unavailable recovery remains terminal for that socket. A 4401 against
a locally live lease retires its scope. The owner hook may separately read the
current source again. The existing 1013 unavailable close remains unchanged.

The session authority/controller remains above the private client subtree.
Accepted session identity and the subtree key are one atomic state update.
UID, SID, generation, binding and version changes retire request receipts before
publication and remount client state with a matching QueryClient persistence
buster. Initial unconfirmed admission does not restore or erase a private
persisted scope. Bearers are excluded from persisted queries and messages.

This client remount does not qualify private server-component props or Next
Router Cache/prefetch payloads. Viewer-derived SSR islands still need an exact
server owner tag and mismatch suppression/refetch before public activation.
Meaningful independently public SSR content must remain available. The dark
source and injected transport tests do not constitute an actual browser or
supported-engine qualification.

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

WWW client transport/state/cache adoption remains subject to the private SSR
and actual-browser gates above. Expo-web consumers still require complete
adoption of owner-bound results and memory freshness. The actual cross-origin
bootstrap, authenticated distinct-binding controls, rolling-proof expiry,
cookie-family GC, supported-engine matrix and recovery protocol also remain
required. The readiness function stays false until the complete browser contract
is reviewed and qualified.

An additional first-observation gate remains: a tab holding legacy A may receive
503 on its first central session read after another origin selected B. It has
not observed selected metadata and cannot inspect WWW's host-only correlation
cookie. Preserving its old legacy bearer during that uncertainty must not be
mistaken for selected account isolation. Public activation requires an explicit
canonical selected-dispatch observation even on refusal/unavailable responses,
or a qualified client mode that requires selected admission before dispatch.
An eventual successful session response alone does not cover this interval.

The native OAuth callback decodes `getAdmittedRawServerToken()` as a NextAuth
JWE. Since #7596 that reader returns only the admitted NextAuth cookie, so no
backend lease reaches the callback. A backend delegation must never be decoded
or reused as a source credential.
