# Web credential proofs and sensitive writers (BA-04 PR 9c)

These paths stay dark by default. They do not switch identity authority, enable
canonical issuance, activate writer modes, or close the Garmin offline-queue
gate. The first-party production handler remains unmounted. The owner runbook
is issue #7430; no production action is authorized by deploying this slice.

## Rollout contracts

| Selector | Web | Backend | Default |
| --- | --- | --- | --- |
| `CURRENT_STORE_WEB_CREDENTIAL_PROOF_MODE` | `off`, `required` | `off`, `compatible`, `required` | `off` |
| `CURRENT_STORE_SET_PASSWORD_MODE` | `legacy`, `backend-staging` | `legacy`, `backend-staging` | `legacy` |
| `CURRENT_STORE_WEB_SIGNOUT_MODE` | `legacy`, `backend-staging` | `legacy`, `backend-staging` | `legacy` |

The existing private auth protocol version remains 2. Password and OAuth
resolve requests negotiate credential-proof extension version 1 explicitly.
Old request/reply shapes remain unchanged when no extension is requested and
the backend is `off` or `compatible`. An upgraded web in `required` mode rejects
an old backend or a successful reply missing its proof; it never falls back to
a local password lookup or reads a newer generation from the web database.
A backend in `required` mode refuses successful unstamped old requests.
`compatible` is backend-only; selecting it on web cannot mint a login.

Deploy compatible code on the backend first, then move web to required proofs,
then require proofs on the backend. Complete every existing writer, fence and
rehearsal gate before activating staged writers. These are ordering contracts,
not instructions to turn modes on now. Set-password delegation requires proof
mode `required`, and uses the existing backend origin and distinct private RPC
secret. No secret or command body is logged.

The SID sign-out writer is independent of bridge/cohort selection. Its backend
must be deployed before its web forwarder is selected. Once enabled, **never
return this writer to `legacy` to roll back the bridge or a cohort**. Keep its
RPC origin and secret. The 9a denial reader is the backend rollback floor; the
new buffered forwarder is the web floor once this writer is enabled. Startup
refuses bridge `on` without the writer/secret, and new writers refuse observe
mode and SQL parameter logging. Canonical issuance remains unmounted and must
honor the same writer prerequisite when it is introduced.

## Proof and freshness rules

Backend password verification returns a subject, stable login SID, generation,
authentication time and guarded-provenance bit from the transaction that
validated the credential snapshot. OAuth resolve does the same under its
existing subject lock. A callback with an existing actor inherits that actor's
SID, authentication age and guard bit; it cannot convert a provider-link
callback into a fresh authentication of an old session. Unverified mailbox
state remains unverified.

The web uses these exact stamps. A reset after the backend reply therefore
leaves the pending cookie with its old generation and primary admission refuses
it. Neither a post-reply database read nor a failed read can bless it with a
newer generation. Genuine password/provider sign-ins can be guarded while
partner mode is off. Rotation preserves stamps; JWT `iat` and transfer `iat`
never establish authentication age.

The existing staged provider helper still refuses new links from an actor, and
the delegated adapter refuses link/unlink mutations. This slice does not enable
a new provider-link or unlink command. Required-proof mode cannot enter the
legacy OAuth adapter and perform an unfenced direct identity write.

## Set-password

The public web route keeps validation and per-IP/user limits. In staged mode it
forwards the exact presented JWE to the backend, together with the displayed
UID/SID as negative identity guards. Those IDs grant no authority. The backend
verifies/admit the credential on the primary, requires guarded authentication
within five minutes, hashes outside locks, then admits the same proof again
under the gate and user lock in its caller-owned transaction.

Credential insertion, generation increment, revocation bookkeeping and the
mirror commit together or roll back together. Adding a password does not prove
mailbox ownership, so it does not change an existing verification timestamp or
turn NULL into verified. Existing passwords are not overwritten.

The replacement cookie retains the authenticated subject, public SID,
authentication age and original expiry bound. It carries only the committed
replacement generation. Primary admission is checked before its cookie headers
are emitted; a second reset after the reply cannot upgrade the replacement.
The new cookie-writing endpoint shares the existing client fetch lock. This
does not claim to solve the broader BA-05 cross-tab Set-Cookie ordering problem.

Unknown, unguarded, stale or future age asks the web user to sign in again; the
translated action clears the old web session through the guarded sign-out flow
and returns to Settings after login. A changed displayed identity causes no
write, clears the password fields and refreshes the displayed account. The
installed native/watch protocol receives no new freshness requirement.

## Sign-out and transfers

The existing public NextAuth identity guard and CSRF handler run first. Their
session-cookie clears, including chunks, remain buffered until the private
backend RPC acknowledges a stable SID denial. An outage, unknown result or
unproven lineage produces 503 with no cookie-clearing headers. Stable already
ended SIDs are acknowledged idempotently. An unrecoverable no-SID credential is
not falsely reported revoked and does not cause an account-wide fallback;
normal session renewal must establish stable lineage before retry.

Native transfer payloads carry the signed source SID, generation and known
authentication time/guard. Required mode derives them from the exact admitted
source JWE. Older transfer payloads retain their compatibility treatment;
neither producer nor consumer treats a new transfer timestamp as a new login.
No native application or Bluetooth code changes here.

## Verification

Owned localhost fixtures exercise actual backend RPCs, production NextAuth
callbacks, public sign-out CSRF handling, real encrypted cookies and primary
admission. Races include reset after the password reply and a second reset after
a set-password reply. Other proofs cover preserved age/SID/expiry, unknown
freshness, negative identity binding, exact bcrypt bytes, unverified state,
mirror rollback, unavailable denial authorities and guarded actor inheritance.
The existing default-off route/component suites remain part of regression QA.

Production startup still refuses the staged SID denial writer, with no environment
bypass. Historical issuer retirement and old credentials without a stable SID
remain unqualified. Elapsed token lifetime alone does not close that gate.
Function-level tests qualify the dark implementation only; they do not authorize
activation or prove cross-tab Set-Cookie response ordering.
