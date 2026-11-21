# BA-04 selected-authority provider security

The owner approved explicit Google/Apple linking and unlinking with actual
reauthentication within five minutes. The requesting browser keeps its original
session ID, authentication age and expiry while its generation advances. Other
first-party/native sessions, partner credentials and older recovery/verification
credentials are revoked. Facebook is excluded from product sign-in and linking;
its stored identities and historical migration/prototype evidence remain readable.

The [accepted migration](better-auth-migration.md) owns the architecture.
[#7430](https://github.com/boardsesh/boardsesh/issues/7430) owns rollout gates.
The [current lifecycle test map](better-auth-implementation.md#current-test-map)
identifies provider coverage. The original BA-01 prototype was removed in #7620;
its historical proof is not the mounted callback transaction design.

## The web half is gone

This doc describes the backend core: the private commands, their transaction
and their receipts. #7596 deleted the www half that was built to call them.
None of it ran in production, because its readiness gate
(`publicProviderSecurityReady()`) returned `false`. The deleted pieces are the
Settings link and unlink UI with its server routes, the Google
reauthentication web seam, owned-account and anonymous Google/Apple sign-in,
the sign-in ACK, and last the shared web core in `packages/web/app/lib/auth`:
the server-only command client, the NextAuth candidate issuer, the sealed flow
cookie, the actor selection, the Settings resume URL and the readiness gate
itself. Nothing on www calls `/api/internal/auth/current-store/provider-security/v1`
any more; Google and Apple sign-in on www run through the legacy NextAuth
handler.

The backend commands, their handler and the shared `provider-security-v1`
protocol stay. B5 rebuilds the web layer on the shared-domain session
([better-auth-browser-session.md](better-auth-browser-session.md)). Where
the sections below mention a broker, a publication factory, Settings wiring or
a per-selection cookie reader on www, that code no longer exists.

## Actual reauthentication

An operation-bound receipt requires a real comparison with the current selected
password hash, or a verified Google ID token carrying a supported recent signed
`auth_time`. The writer rechecks the password hash or already-owned Google subject
under the user/provider locks. A Google assertion belonging to another user cannot
authorize linking, including when the target provider is Apple.

The receipt binds exact user, requesting credential hash/kind, SID, generation,
intent, operation, provider and selected-authority receipt. Its deadline is
bounded by the signed authentication event plus five minutes, provider proof
expiry, source credential expiry and intent. No session age stands in for it:
a login, bridged or carried session signed in seconds ago still needs a receipt.
Callback time, token `iat`, transfer/code issue time, refresh, navigation,
`prompt=login` and `max_age` do not establish freshness.

> **Re-keyed by #7596 B5c1.** The actor is the first-party web session, not a browser binding; see "Provider and first-password flows" in [better-auth-browser-session.md](better-auth-browser-session.md).

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
cutoff, intent, then locked primary owner rechecks. Selected ownership and
generation are reread after waits. Email matching never links identities, moves a
subject or rewrites the local profile/verification. Unlink must retain one usable,
unambiguous configured password or Google/Apple method.

Preparation writes only the bound pending proposal and mints nothing. In one
transaction finalization performs the provider mutation and selected-direction
mirror, records the generation/cutoffs and partner revocation, and keeps the
requesting session in place: same id, token, sign-in time and expiry, at the new
generation, checked against the branded mutation receipt. Every other first-party
credential of the account ends. Every identity/credential write shares a
savepoint. Validated policy/finalization failures may terminalize only that
intent; wrong, stale or signed-out actors cannot consume the intent or proof.

Lost-success recovery requires the same live session, at the generation the
commit gave it, and the original intent, recovery and proof capabilities. It
returns only an ACK and that generation, never a bearer. ACK expiry is bounded
to two minutes and the original proof/intent/source deadlines.

## Evidence and remaining gates

### Google and Apple sign-in

Since #7596 B5a, a Google or Apple web sign-in is the web OAuth `resolve`
command with `webSession` (see [better-auth-browser-session.md](better-auth-browser-session.md)):
it issues a first-party web session in the transaction that resolved the
identity and revokes the session it arrived with. The browser-binding
`signin-*` commands and the anonymous-provider protocol are deleted. A sign-in
never mints a reauthentication receipt and never links a provider to the
session it arrived with.

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

#7596 deleted the request-local NextAuth publication factory, the per-selection
cookie reader and the Settings wiring before any of them was mounted. B5 builds
the flow broker, its publication and the whole mounted late-failure callback
proof on the shared-domain session. Framework JWT/encode/event,
admission, body/redirect rewriting and cookie-capacity work must finish before the
identity transaction commits. Any future publication may only return the already
constructed bytes after finalize. Source qualification does not enable production
flags or close browser/device, old-writer, issuer, role/pool or hardware rollout
gates in #7430.
