# BA05 browser cookie response-order counterexample

The dedicated QA proof characterizes the existing NextAuth cookie slot. It does
not activate a writer, change response admission, or fix account switching.
Rollout ownership remains in #7430.

At integration commit `265310e046`, Chromium passed three successful-publication
controls and failed six later-login acceptance cases. A completed earlier A
response overwrote the later login for every tested response family:

| Completed response held before headers | Later other account | Later same user, new SID |
| --- | --- | --- |
| Public session renewal | Earlier A restored | Earlier A SID restored |
| Actual set-password replacement | Earlier A restored | Earlier A SID restored |
| Actual Apple callback | Earlier A restored | Earlier A SID restored |

Each case verifies the later cookie is stored and shared before releasing A,
then checks both the exact UID/SID and a fresh public session read. The three
controls verify these same responses can publish A when no later login occurs.

The fixture uses HTTPS `www.boardsesh.test` and `app.boardsesh.test`, the shared
`.boardsesh.test` HttpOnly cookie, the real app-origin allowlist/CORS helper,
and an actual return-to-app credentials callback. Only owned loopback listeners
and synthetic accounts are used. Browser requests to every other origin are
blocked. Real route exports run through an owned HTTP bridge; this is not a full
Next server or deployment proof. The external Apple provider is synthetic. The
set-password source is an explicitly public-encoded synthetic guarded proof;
its backend mutation, receipt, replacement response and later login are real.
WebKit was not installed in this environment and remains unqualified.

Run only against the explicit disposable local fixture. This command is
intentionally nonzero until guarded publication satisfies the six invariants:

```sh
BOARDSESH_AUTH_PROOF_DATABASE_URL='<owned localhost admin URL accepted by the proof>' \
  vp test run --config packages/backend/auth-proofs/cookie-order.vite.config.ts --reporter=agent
```

The expired-cookie cases in the older publication proof are not new evidence:
current response admission emits no clearing cookie for that refused source.
The positive response-order gap remains. A final server check cannot make an
already delayed `Set-Cookie` conditional on a later login. Origin-scoped locks
and component epochs do not span www/app or top-level callbacks.

> **Note for #7596.** This section stays. It is the real race, and acceptance item 1 of #7596 reruns this fixture on Chromium and WebKit. Under the re-scoped design in [better-auth-browser-session.md](better-auth-browser-session.md) only login and sign-out responses write the session cookie, so the renewal and set-password rows above can no longer restore an earlier account. The two Apple callback cases are a login racing a later login, which #7596 accepts: the browser keeps whichever login response arrived last, and no data crosses accounts. When the fixture is rerun, those two cases need the accepted outcome as their expectation instead of counting as failures. That last point is inferred from the spec, not run.
>
> **Not rerun yet (`B7C_COOKIE_ORDER_FIXTURE`).** Both cutover lists carry `B7C_COOKIE_ORDER_FIXTURE` (backend `BROWSER_SESSION_CUTOVER_BLOCKERS`, www `BROWSER_SESSION_WEB_CUTOVER_BLOCKERS`) until this fixture runs against the new design. Missing, as of #7810: (1) it still drives the NextAuth cookie slot (`__Secure-next-auth.session-token`) through the legacy route exports; it has to be rewritten against www's `better-auth` routes (credentials login, guarded sign-out, the bridging session read) and the `__Secure-boardsesh.*` cookies; (2) WebKit has never run it; (3) the two Apple callback cases still count the accepted last-login-wins outcome as a failure, and the Apple callback under `better-auth` has no stand-in provider yet (`B5E1_APPLE_LINK_PROOF`, `B5B_WWW_PROVIDER_SIGN_IN`); (4) it is a deliberately failing proof outside every CI job, so a pass would not be repeated. The browser acceptance run (packages/web/e2e/browser-session) covers the cookie-writing contract of acceptance 1 on both engines, not this race.

## Dark backend selection prerequisite

> **Superseded by #7596.** This section describes the browser binding core, which is being removed. See [better-auth-browser-session.md](better-auth-browser-session.md). The section is deleted with that code; the section above stays.

The dark `browser-binding` core in #7465 adds a digest-stored opaque correlation
binding and versioned one-use intent records. It is stacked on the dedicated
credential connection in #7467. The binding alone cannot authenticate a selected
login or start an authenticated transition. Reads require the actual client-held
current-version JWE or canonical token, including its exact credential kind,
UID/SID, generation, authentication age and ancestry. A newer intent invalidates
an older pending login/replacement/logout. The core captures and revalidates
selected authority around the whole transaction.

The stored selection retains credential kind, UID/SID, generation, original
proof age, conservative ancestry and original credential deadline. Canonical
selections verify the actual presented token and optional lineage through the
existing canonical reader on every read and consumed retry. No token is
materialized from a stored SID. Row removal, expiry or lineage
revocation cannot leave a positive cached selection. A shorter live expiry is
honored; ordinary expiry extension stays capped by the stored original deadline
and does not manufacture authentication age. Initial canonical admission is
repeated after waiting for the binding lock, using the exact presented token.
Logout requires the exact actor credential bound when its intent was prepared.
It re-admits that selection before revoking credentials. A refused old selection
clears only its binding; unavailable admission cannot acknowledge or consume
logout. Password continuations retain credential kind, so a canonical selection
cannot be downgraded to a legacy JWE. Legacy selections also check primary
subject generation and SID denials.
No raw source credential or canonical token is persisted in the binding.

Generated migration `0312_browser_binding_selection` creates the final browser
schema after main's independent CNC migration0311. It includes the format
version, actor-credential hash and exact result-credential hash on intents. New operations
use format 2; old format-1 intents fail closed. The original actor bytes must be
retained by a sealed flow carrier until completion, because ordinary renewal
may change the browser's current JWE. A consumed retry must present the original
actor and exact committed candidate bytes, remain at the current selection and
pass primary admission. It cannot retrieve or reconstruct a newer credential.

Replacement is a same-transaction prepare/mutate/commit operation. Preparation
checks current possession and binds the exact intent, actor, candidate,
operation ID, permitted mutation kind and original deadline in an unforgeable
in-memory capability. Commit also requires that physical transaction's checked
generation-mutation receipt, the exact cutoff/event and selected authority.
Reset, deletion, administrative revocation and signout cannot authorize
current-device preservation. A generation increment alone is insufficient.
Every late refusal throws to roll back password/provider work with selection
and intent consumption. Final clock checks also reject expiry during the last
write.

The core proof passes 125 cases on real disposable PostgreSQL databases across
both selected authorities, independently replayed. It includes the original
canonical lifecycle and observed lock waits, direct known-token fixation
controls, wrong/missing actor and source-kind refusal, exact-candidate retries,
forged/copied/cross-transaction and wrong-operation receipt refusal, original
SID/age/ancestry/expiry preservation, and real password/mirror/cutoff rollback.
Two final-write deadline cases observe an actual PostgreSQL advisory-lock wait
and the database clock crossing the deadline before release; they do not infer
rollback from a test or SQL timeout. The original unpublished browser0311/0312
steps were regenerated through Drizzle as one0312 migration after CNC. Its
physical column order, defaults and constraints match the reviewed two-step
schema; existing format-1 intents retain their fail-closed behavior.

```sh
AUTH_PROTOTYPE_DATABASE_URL='<owned localhost admin URL accepted by the proof>' \
  vp test run --config packages/backend/vite.auth-authority.config.ts \
  packages/backend/src/auth/authority/__tests__/browser-binding.test.ts --reporter=agent
```

This is a backend prerequisite, not a repaired browser publication result.
No public session/bootstrap/coordinator routes or www/app transport adoption
are mounted, and #7596 deleted the unused `BROWSER_BINDING_PUBLIC_BOOTSTRAP_READY`
constant that said so. A single canonical-origin initialization and shared
coordinator, private command/CSRF/Origin proof, actual publication and cross-tab
transport, per-version host-only source-proof cookies, all authoritative reader
adoption, ordinary same-selection renewal, missing-proof/expiry recovery,
rollback and final browser response-order replays
remain required. The nine-case Chromium counterexample above still describes
the currently mounted routes; this private core does not close those gates.
