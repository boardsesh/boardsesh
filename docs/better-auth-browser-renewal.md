# Selected browser rolling renewal

Implementation work for #6975; activation and browser/device gates remain in
#7430. Public readiness stays false. This flow preserves the released 30-day
rolling lifetime without claiming a new authentication event.

The private renewal protocol is separate from login and provider continuation.
Login permits a different UID/SID; provider continuation increments generation
and revokes other credentials. Neither supplies ordinary renewal's invariants.

Prepare admits the exact currently selected source and records hash-only
operation evidence in `auth_browser_renewals`. It freezes the authority epoch,
actual UID/SID/generation, original age and account-cutoff provenance, source
hash/deadline, binding version/revision and a second-aligned database-clock
target expiry 30 days ahead. Preparation lasts at most one minute and never
outlives the actual old source or binding. Pending live account-change intents
take precedence; ordinary session polling must not cancel a provider action.

Before finalization, the canonical WWW adapter must buffer the entire success
response, the future version-named proof, retained old proof and constant
relative correlation-cookie refresh. The complete next request must fit both
byte and pair limits. Legacy issuance verifies the actual NextAuth encoded JWE
against the exact frozen expiry; a second-boundary mismatch fails closed.
Historical no-SID sources retain `legacy_no_sid` even when their admitted
synthetic SID becomes explicit. A renewed `iat` or `jti` never proves age.

The final transaction re-admits actual source after lock waits and compares
every frozen field. Canonical renewal retains the same opaque token, extending
only its existing session expiry/update time. It preserves session creation,
original authentication and lineage evidence and refuses missing, revoked or
foreign rows. Legacy candidates must retain owner, SID, generation and
provenance; any matching canonical mirror keeps its existing opaque token.
The binding advances exactly one version and extends its database retention in
the same transaction. Its original fixed bootstrap deadline must not end an
otherwise valid rolling session. Old-source and operation deadlines, primary
cutoffs and authority are checked after real writes so failure rolls back all
changes.

An unknown finalizer outcome publishes no current proof or ordinary session
cookie and never retries mutation. The previously delivered operation carrier
remains available only for exact read-only acknowledgment.
Read-only acknowledgment requires the exact operation/preparation plus actual
old and new source possession and current primary selection. No operation row
stores or reconstructs a bearer. Retained operation expiry indexes support a
separately reviewed retention procedure; no existing data is deleted here.

The publication continuation adds a narrowly bounded acknowledgment after an
old source or binding deadline. Finalization still requires every parent to be
live through its last database-clock check. Acknowledgment requires immutable
source-byte possession, an exact durable candidate hash, a completion timestamp
before every frozen parent deadline, and the same live current candidate,
authority epoch and cutoffs. Its database deadline is five minutes after that
completion; the last authority await cannot extend it. This grants no generic
expired-source admission or fresh authentication. Canonical renewal keeps the
same actual token; old browser versions still refuse. Legacy verification keeps
its existing 60-second transport clock grace.

A separate operation-named encrypted HttpOnly carrier retains both actual old
and candidate credentials before commit. Its AEAD purpose, exact canonical host
and operation hash are bound together. This carrier is actual credential
custody, not metadata-only flow state. It cannot be used as a current proof
before exact durable acknowledgment. Its deadline is bounded by preparation
expiry plus five minutes and the future credential/binding deadlines. Complete
physical chunks and whole-cookie pair/byte capacity remain mandatory.

Preparation must also refresh the exact existing correlation cookie's constant
relative lease. Otherwise an unknown finalizer response near its physical
expiry could strand recovery. Retain the carrier and old proof until a later
request presents the complete installed current proof, even after emitting
successful response headers. GET observation may acknowledge only; it never
finalizes an uncommitted preparation. Orphan carriers cannot bootstrap a fresh
anonymous binding. The public join is staged behind code-owned false readiness.

Qualification must cover both authorities and credential kinds, unknown-age
and no-SID ancestry, preservation of unrelated sessions, renewal past the old
login/binding deadline, delayed older responses, lock waits, competing login /
logout / provider changes, exact encoding expiry, post-write expiry rollback,
whole-cookie capacity and uncertain completion. Missing-proof recovery and
supported-browser two-account cancellation remain separate acceptance gates.

The private HTTP namespace is `/api/internal/auth/browser-renewal/v1/` and is
disabled unless both browser-binding and renewal modes select backend staging.
It authenticates the service, validates the exact path and bounded command,
and checks request freshness before opening the credential pool. It never uses
the shared content pool or emits browser cookies.

`private-browser-renewal-v1` is an explicit sixth credential-writer contract.
The five earlier contracts keep their existing capability maps. The sixth
adds only `SELECT` and `INSERT` on the generated renewal relation and column
updates on its four completion fields. It has no relation-wide update or
delete grant. Catalog qualification pins the generated relation shape, and
an unqualified or differently configured pool refuses the command. The
canonical CI fixture runs the renewal and five compatible HTTP handler suites
serially under that actual LOGIN. Historical profile proofs stay separate.

The staged public adapter exposes separate prepare and commit POST routes under
`/api/internal/auth/browser-coordinator/renew/`. A canonical frame retains the
same navigator lock across preparation, physical commit-body settlement and a
final primary observation of installed cookies. Cancellation retains the lock
until body cancellation settles and prevents every later network dispatch.
Lost commit responses are never retried automatically; later observation may
publish only the exact durably acknowledged candidate.

Ordinary polling first admits the actual current source. If both admitted
source and binding have more than 29 days remaining, it refreshes only the same
correlation cookie and preserves the current version. This limits rolling to
approximately once per day without changing the database's 30-day target or
manufacturing authentication age. Confirmed anonymous observation does not
refresh its finite binding lease. Refusal and uncertainty remain distinct from
confirmed anonymity.

WWW SessionProvider and the Expo browser store call the fixed canonical frame
before requesting their independently authenticated session packet. Coordinator
metadata contains no identity and never supplies that packet's authority. The
Expo selected path enters no legacy cookie lock, preventing the same-origin
app shell from nesting its old lock with the canonical frame's lock. Provider
and native-start preflights remain read-only so polling cannot supersede their
pending account-change intents.

Public readiness remains false. Explicit expired-binding login retirement,
missing-proof recovery, remaining app callers, complete writer coordination and
supported-browser physical delivery remain prerequisites to activation. Source
and local HTTP/database proofs do not qualify those application gates.
