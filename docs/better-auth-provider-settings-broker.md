# Provider Settings browser broker

The Settings broker is a server-only factory for reading selected sign-in
methods, recording an explicit Google/Apple link or unlink intent, and
submitting the account's actual password for an operation-bound reauthentication
receipt. Six public route exports delegate to this boundary with code-owned
readiness still false. A controller now mounts the reviewed card in Settings
and composes those presentation requests. Default requests remain unavailable;
the complete OAuth outer-handler and canonical bootstrap join are separate work.

Each request requires an exact Host matching the configured canonical HTTPS
origin. The standalone server's internal request URL supplies only the route
path; forwarded host and protocol claims supply no authority. Mutation requests also require
the exact Origin header, JSON content type, and a same-origin Fetch Metadata
value when supplied. Body reads have a fixed 64 KiB UTF-8 budget and a five-second
deadline. Neither HTTP input nor environment readiness claims select a larger
budget or enable the public flow. Actual external TLS and proxy behavior remain
a deployment and browser qualification gate.

Only `readPresentedBrowserSelection` supplies an actor. An unavailable primary
remains unavailable; missing, refused or stale possession cannot fall back to a
legacy cookie. The methods response contains usable methods and an opaque UI
actor key, with no UID, SID, source credential, private cursor or authentication
age. That key cancels stale UI work; it never authenticates a command.

The methods and resume GETs also require `X-Boardsesh-Provider-View`, a SHA-256
correlation of the accepted public Session owner tuple (UID, SID, generation,
binding ID/version), under a dedicated frame. The client must hold the actual
process-local accepted Session receipt before computing or sending that label.
The server independently admits cookie possession and compares the label before
loading methods. A stale A page therefore cannot receive B's methods when its
cookies have changed before its central view observes B. The label grants no
authority and carries no source token or authentication age.

The server checks the expected UI actor before creating an intent or comparing
a password. A per-operation `__Host-` cookie seals the intent capabilities,
original source hash and provenance, browser binding/version and deadlines.
Only its digest selector reaches public JSON. The cookie is HttpOnly, Secure,
SameSite=Lax and expires at the original intent deadline. A subsequent request
must present the actual current browser proof and match every sealed actor
binding before a private command runs. The server re-reads the primary after
private work and withholds the operation cookie if the actor changes, the source
expires, the primary becomes unavailable or the request aborts.

Intent creation and password comparison use the existing process-local limiter,
keyed only by the primary-admitted account. The limits are ten intents and five
password attempts per minute. This is best-effort protection per web process,
not a distributed quota. Proxy addresses cannot lock unrelated accounts out.
The browser may keep at most four operation cookies for this broker.

The broker stores only the returned encrypted reauthentication capability. It
does not retain a password, expose proof capabilities in JSON, change the
requesting session's original age or expiry, create a credential, or finalize a
provider mutation. Its injected-client tests qualify this HTTP and sealed-flow
boundary; they do not replace the existing real bcrypt/Postgres proofs.

The actor-bound resume GET reads the existing sealed operation and re-admits its
exact original source. It returns only the existing public resume schema, with
no mutation, capability, cookie publication or new freshness proof. The client
first attempts an exact read-only ACK. Only an ordinary absent-result refusal
may lead to the pending-flow reader; unavailability never triggers that fallback.
Resuming opens the controlled card for explicit confirmation. The Google and
Apple sign-in calls carry only the existing operation, selector and canonical
localized Settings callback fields accepted by the OAuth flow reader.

The controller owns one actual accepted Session and manager revision. It checks
that ownership before dispatch and after each asynchronous boundary, with one
15-second signal bounding hashing, fetch, stream reads and the supported JSON
fallback. A later account or A→B→A cycle retires its requests. The Settings URL
retains only the public operation selector for recovery; passwords and proof
capabilities never enter storage or history. An unknown unlink result, including
malformed successful JSON, retires and refreshes only the still-current captured
view. An aborted A request cannot retire B. Successful replies are checked
against the exact operation-specific shape. The card offers recovery only when
the admitted methods prove a usable existing password; unsupported Apple-only
accounts receive no unusable reset/setup link.

Actual Google reauthentication, complete buffered OAuth publication, ordinary
owned-account sign-in, canonical bootstrap and complete browser transport still
require joined application qualification. The
[provider-security adoption record](./better-auth-provider-security-adoption.md)
and rollout issue [#7430](https://github.com/boardsesh/boardsesh/issues/7430)
retain those activation gates. Apple-only first-password email setup is a
separate purpose-bound flow; its email confirmation is never provider freshness.

## Direct unlink publication

The default-dark direct publication factory composes the selected actor reader,
sealed operation, actual credential issuer, cookie planner and private
prepare/finalize commands. Its caller must first apply the Settings route's
canonical Host/Origin and bounded JSON checks. Default readiness remains false,
and both provider and browser staging selectors are required.

Before finalization, the factory re-admits the same actual actor and builds the
entire successful JSON response plus future-version proof cookies. It preserves
the original credential kind, SID, authentication age and expiry. Cookie expiry
is capped by the original source and binding deadlines; no rolling Max-Age can
extend it. The complete observed request header counts toward capacity, and
literal proof retention preserves the old actor and operation carrier. Failed
preparation publication aborts only the pending preparation. A lost or uncertain
finalizer reply never triggers an abort, retry or candidate-cookie publication.

The separate acknowledgment method requires both physically observed source
versions, current primary candidate admission and the exact backend result. It
rechecks primary selection after the private acknowledgment. Its public reply
contains only a completion outcome, with no bearer, cursor, hashes or cleanup
cookies. Missing candidate bytes cannot be recovered from the sealed carrier.

The required HTTPS Chromium task exercises this factory with actual password
comparison, provider preparation/finalization, canonical or JWE issuance and a
next-request acknowledgment across both authorities. Body-loss, unknown-finalizer
and whole-header capacity controls use the same server seam. These fixtures use
an explicitly injected owned database. The Settings JSON driver also streams
actual browser request bodies, canonical Host/Origin and cookie headers through
the same dispatcher, proves a stale UI key leaves the operation unchanged, and
completes unlink plus exact ACK across both authorities and source kinds. The
actual App Router exports separately prove their production code gate remains
false despite staged environment and HTTP claims. These do not qualify the
complete Next.js application, restricted LOGIN composition, external proxies or
the full browser response-order matrix.

An expired or refused resume selector leaves independently admitted current
methods available. The warning does not start another operation: the climber
must explicitly confirm a fresh change, and its reply must still belong to the
same accepted Session and authority revision before it updates Settings.
