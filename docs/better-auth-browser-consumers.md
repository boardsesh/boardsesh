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

## Public server payloads and private client views

Hiding server children behind a client component does not remove their props
from React Flight. The selected profile, statistics and profile-session routes
therefore omit viewer-private server seeds entirely. The profile card is fetched
without a credential and contains no owner email, local board mappings, logbook,
stats or beta seed. Its public name remains an `h1` with existing crawlable links.
The legacy rendering branch retains its existing behavior.

Selected gym management sends only the route slug and public owner tuple to its
client island. Its metadata uses the generic utility title without looking up
the private gym. The client fetches the gym through the owned GraphQL transport
only after the actual accepted SessionContext object matches UID, SID,
generation, binding and version. A copied session object cannot supply that
private local receipt. Invalidation, retirement, disposal and exact-tuple ABA
invalidate earlier accepted-session receipts independently of public metadata.
Subscriber failures cannot stop another view from receiving retirement.

The private-view boundary uses a synchronous external-store subscription; its
server HTML is the independently public fallback. Children of this boundary
must never include private server props. Mismatched cached route labels request
one shared route refresh per accepted response. Same-owner invalidation requests
one central session refresh per local revision, without superseding an already
admitted account transition that is awaiting ordered preference cleanup.

Page suspension retires selected receipts, flushes the private DOM removal
synchronously before the event returns, and aborts pending session reads.
A restored document must accept a new primary-backed session response before
these client islands reveal private content. Event-driven React tests cover
suspension, outages and abort-ignoring old bodies; they do not establish actual
browser BFCache behavior.

This is a bounded source change. Remaining viewer-derived pages, private cookie
JSON reads, server actions, native handoff, actual HTML/Flight/prefetch sentinel
checks and supported-browser history/BFCache races remain rollout gates in
#7430. In particular, a cache remount or event test is not evidence that every
private response or restored document has been qualified. Public readiness
remains false.

### Selected build-plan orders

Selected purchase-history and order-detail server responses contain only public
catalog data, route parameters and owner metadata. Orders, buyer fields and
preview URLs are loaded by the admitted browser. The same pure order-list view
serves legacy server rendering and the selected client without duplicating its
layout. Existing utility metadata and noindex behavior remain unchanged.

The configurator, order views and polls partition state/cache keys by the actual
accepted browser tuple and its local retirement revision. Invalidated data
cannot reappear merely because the same tuple is admitted again. Confirmed
anonymous configuration remains separate from an unavailable selected owner.
Private islands share one central refresh per actual Session object/revision;
an already admitted different owner awaiting preference cleanup is preserved.

CNC actions capture the caller's original opaque lease scope before sending.
After their own awaits, they also check the actual decoded GraphQL result's
private receipt. That receipt retains the original delivery lease and caller
abort signal; a renewed same-owner lease cannot extend an older result's
deadline. Original direct operation objects/arrays are covered for up to 64
top-level fields, without recursively walking a response. Copies and restored
objects carry no receipt. Preview seeding, checkout after draft cleanup and
download navigation all use these guards; uncertainty never replays a mutation.

Source tests use the installed GraphQL client and real memory manager, including
same-owner renewal, delayed post-body consumption, cancellation, exact-tuple
re-admission and the retained legacy views. Actual Next Flight/history and
supported-browser qualification remain required; these tests do not activate
the browser contract or authorize a payment/production change.

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

The existing native OAuth callback still decodes `getAdmittedRawServerToken()`
as a NextAuth JWE. The selected forwarding branch returns a backend-only lease,
which that decoder correctly refuses. This slice does not qualify that handoff:
it needs its own actual-source transfer adapter before public activation. A
backend delegation must never be decoded or reused as a source credential.
