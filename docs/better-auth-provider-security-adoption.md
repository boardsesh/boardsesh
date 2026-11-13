# BA-04 selected-authority provider security

The owner approved explicit Google/Apple linking and unlinking with actual
reauthentication within five minutes. The requesting browser keeps its original
session ID, authentication age and expiry while its generation advances. Other
first-party/native sessions, partner credentials and older recovery/verification
credentials are revoked. Facebook is excluded from product sign-in and linking;
its stored identities and historical migration/prototype evidence remain readable.

The [accepted migration](./better-auth-migration.md) owns the architecture.
[#7430](https://github.com/boardsesh/boardsesh/issues/7430) owns rollout gates.
The [original provider proof](./better-auth-provider-link-proof.md) remains
historical evidence rather than the mounted callback transaction design.

## Actual reauthentication

An operation-bound receipt requires a real comparison with the current selected
password hash, or a verified Google ID token carrying a supported recent signed
`auth_time`. The writer rechecks the password hash or already-owned Google subject
under the user/provider locks. A Google assertion belonging to another user cannot
authorize linking, including when the target provider is Apple.

The receipt binds exact user, requesting credential hash/kind, SID, generation,
browser binding/version, intent, operation, provider and selected-authority receipt.
Its deadline is bounded by the signed authentication event plus five minutes,
provider proof expiry, source credential expiry, browser binding and intent.
Callback time, token `iat`, transfer/code issue time, refresh, navigation,
`prompt=login` and `max_age` do not establish freshness.

Google's signed session-age claim requires the applicable app configuration and
does not make an ordinary OAuth continuation a reauthentication request.
See [Google Security Bundle](https://developers.google.com/identity/siwg/security-bundle).
The mode `CURRENT_STORE_PROVIDER_GOOGLE_AUTH_TIME_MODE=auth-time-staging` only
selects the qualified reader; actual provider-console enablement remains an owner
gate. Missing, unsupported or stale claims refuse.

Apple-only users without an existing usable password or qualified already-owned
Google method receive an explicit recent-verification-unavailable result. Current
forgot-password recovery requires an existing password and is not a first-password
setup route. In provider staging mode, cookie-only first-password setup refuses
before bcrypt, command claim or database writes. A separately qualified ownership
challenge is needed before this limitation can be removed.

## Commands and transaction boundary

`CURRENT_STORE_PROVIDER_SECURITY_MODE` defaults to `legacy`. Its explicit
`backend-staging` selector uses the private service-authenticated
`/api/internal/auth/current-store/provider-security/v1` commands. Fixed transport
budgets are 196608 request bytes and 131072 response bytes, counted as UTF-8.
Browser credentials do not authorize the service transport.

The credential pool must qualify the distinct `private-provider-v1` profile.
This profile includes the reviewed web/browser closure, the two provider receipt
tables, the exact nine-kind security-event CHECK and the pinned invoker
`partner_revoke_user(text)` with narrow revocation grants. It cannot issue partner
tokens, read raw tokens, extend their expiry, change connection owners or delete
connections. Old web/browser profiles retain their original catalog contracts.

The lock order is selected-authority gate, sorted provider subjects, actor user and
cutoff/browser/intent, then locked primary owner rechecks. Selected ownership and
generation are reread after waits. Email matching never links identities, moves a
subject or rewrites the local profile/verification. Unlink must retain one usable,
unambiguous configured password or Google/Apple method.

Preparation writes only the bound pending proposal. Finalization receives the
exact caller-held candidate after the complete HTTP response has been buffered.
In one transaction it prepares the browser replacement, performs the provider
mutation and selected-direction mirror, records the generation/cutoffs and
partner revocation, preserves the requesting continuation, and commits the branded
browser replacement receipt. Every identity/credential write shares a savepoint.
Validated policy/finalization failures may terminalize only that intent; wrong or
stale actors cannot consume the intent or proof.

Lost-success recovery requires the exact caller-held candidate, original actor and
flow capabilities, and current primary/browser selection. It returns only an ACK,
candidate hash and cursor. It never reconstructs or returns a bearer from a SID,
old actor hash, intent or reauthentication receipt. ACK expiry is bounded to two
minutes and the original proof/intent/source deadlines.

## Evidence and remaining gates

### Ordinary sign-in to an already-owned account

The separate `signin-intent`, `signin-prepare`, `signin-finalize` and
`signin-abort` private commands handle an admitted browser selecting an existing
Google/Apple account. Their purpose-separated initial/preparation capabilities
reuse the classified OAuth intent table. Hashes bind the exact original actor,
source kind and bytes, SID/generation, browser version, selected-authority receipt,
provider/flow/nonce and immutable prepared candidate metadata. No raw bearer is
stored in those rows. Wrong expected UID/SID cannot advance the browser intent
revision, and an unknown provider subject cannot consume the ordinary flow.

A callback for the same owner preserves the exact current source, original age,
SID and expiry. Switching to another existing owner takes the provider subject
lock, sorted actor/target user locks and a fresh primary owner/generation recheck.
It creates a distinct login SID and a session deadline rounded down to a whole
second and bounded by the fixed browser binding. It does not create, link,
reassign or rewrite a provider identity or profile.

Only independently verified recent Google `auth_time` for that exact owned
subject can populate the new login's original authentication time. An old or
missing claim, an unavailable supported claim reader, and Apple sign-in retain
unknown age with no guarded freshness. A callback clock, token issuance, prompt
or transfer never supplies age. Even a recent ordinary Google login is not an
operation-bound provider mutation receipt.

The complete response must be buffered before finalization. Canonical credential
insertion, flow consumption and the browser login CAS share one caller-owned
transaction; every denial, uncertainty or late expiry after insertion throws and
rolls back all writes. Lost-success retries require the exact retained candidate
and current primary B selection, and return only an ACK/hash/cursor. A primary
outage returns unavailable without an ACK. The original actor's exact UID/SID
bindings still apply to that retry.

The source slice has 38 owned-login PostgreSQL/actual-RSA controls, the existing
125 browser cases and four same-transaction composition cases. Twelve actual
restricted-LOGIN provider HTTP cases include both authorities/source kinds,
unknown-subject nonconsumption and post-commit primary-read outage/restored ACK.
Public ordinary-login publication, broker and Settings integration remain
separate gates; these backend commands do not enable them.

### Checkpoint qualification

The current generated sequence is CNC0311 → browser0312 → provider0313.
Drizzle regenerated the browser schema with its reviewed physical column order
and the provider snapshot with the correct ancestry; provider SQL is unchanged.
The fresh314-entry canonical journal bootstraps successfully. Independent
protected-catalog equality and immutable historical provenance checks pass.
The historical fixture retains the original313-entry journal and both original
browser SQL artifacts, authenticated by their existing full-source digests.
Its reader rejects the newer canonical journal rather than slicing it into old
evidence. Complete current restricted-LOGIN and historical tasks remain the
qualification gates; no production schema or mode is changed here.

The restricted-LOGIN catalog proof covers actual revocation, provider/browser
receipt writes, forbidden token/owner writes, strict old-profile refusal,
unrelated-user preservation and full transaction rollback. The canonical HTTP
matrix runs the existing web and browser handlers under the provider profile and
the provider commands under both selected authorities and both source formats.
It exercises actual password comparison, link/unlink continuation, primary-read
failure, bounded UTF-8 replies and late revocation-permission rollback.

Ordinary signed-in OAuth in provider mode must admit an already-owned selected
subject before legacy command claim or intent consumption. An earlier read-only
preflight is rechecked under the authoritative resolve locks. Anonymous sign-in
remains separate and cannot create an operation-bound fresh-auth receipt.

The request-local NextAuth publication factory, qualified flow broker, current
per-selection cookie reader, Settings wiring and whole mounted late-failure
callback proof are separate composition gates. Framework JWT/encode/event,
admission, body/redirect rewriting and cookie-capacity work must finish before the
identity transaction commits. Any future publication may only return the already
constructed bytes after finalize. Source qualification does not enable production
flags or close browser/device, old-writer, issuer, role/pool or hardware rollout
gates in #7430.
