# Selected browser consumer staging

Epic #6975 rollout remains tracked in #7430. Public selected-browser consumer
readiness is a code-owned function returning `false`. An environment selector
cannot enable these public readers. Bootstrap, recovery, ordinary rolling
publication and whole-client/browser qualification remain open.

## Exclusive source selection

The thin server facade uses the reviewed central presented-browser reader and
backend-issued short lease. Only legacy mode with no reserved correlation-cookie
name may use the existing legacy reader. Selected mode, or any present malformed
or suffixed correlation name, selects the exclusive browser path. An unavailable
gate, missing proof, denied proof or conflict never falls through to an old
NextAuth cookie.

An admitted browser envelope stays server-only. Public session output contains
the authorized profile, SID, generation, public binding ID/version and bounded
ordinary expiry. Binding tokens, actual source credentials, original provenance,
private binding expiry and command capabilities are excluded. A backend lease
response contains only the short bearer, conservative usable duration and public
owner scope. Ordinary readers neither write nor clear auth cookies.

SSR forwarding obtains a backend-issued lease rather than forwarding an opaque
canonical source or reconstructing a token from a SID. One server render shares
its selected-source read and lease issuance; another render reads again. Each
forwarded HTTP or WebSocket operation still receives backend primary admission.

## Response admission

The selected session path projects its central profile directly. It cannot call
NextAuth's legacy session handler against an unrelated older cookie. Other
qualified authenticated callbacks must pass actual selected-source admission
before and after their inner delegate. UID, SID, generation, binding/version and
source kind must stay consistent.

Session, proof and correlation-cookie writes or clears are refused at this
stage. Only the outer prebuilt, backend-ACK-bound publication protocol may add
qualified proof cookies afterward. The trusted fourth completion callback runs
on the exact buffered response after current possession is confirmed; neither
an HTTP marker nor an absent legacy cookie creates this acknowledgment.

An anonymous observation does not acknowledge an authenticated actor. Selected
logout and anonymous mutation delegation remain unavailable until their own
qualified coordinator and durable exact-response receipt exist. No caller
boolean or asserted identity supplies a mutation exception.

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

## Evidence and remaining work

The memory holder has 29 independently reviewed tests, including cached-positive
awaits, scope changes, exact expiry, copied results and bounded timeout recovery.
The server slice has 118 independently reviewed tests across eight affected suites, including
canonical A beside an unrelated legacy B cookie, refusal of unqualified cookie
writes, current-source drift, per-render sharing and unchanged legacy behavior.
Three additional actual ws-auth route tests independently verify that neither
an environment flag nor an HTTP marker bypasses public readiness or selects an
unrelated old legacy cookie.
These server composition tests inject controlled central-reader receipts. The
separate backend PostgreSQL, restricted-role and real HTTP/WebSocket proofs do
not by themselves establish a joined public consumer qualification.

The WWW and Expo-web transport/state/cache consumers still require complete
adoption of owner-bound results and memory freshness. The actual cross-origin
bootstrap, authenticated distinct-binding controls, rolling-proof expiry,
cookie-family GC, supported-engine matrix and recovery protocol also remain
required. The readiness function stays false until the complete browser contract
is reviewed and qualified.

The existing native OAuth callback still decodes `getAdmittedRawServerToken()`
as a NextAuth JWE. The selected forwarding branch returns a backend-only lease,
which that decoder correctly refuses. This slice does not qualify that handoff:
it needs its own actual-source transfer adapter before public activation. A
backend delegation must never be decoded or reused as a source credential.
