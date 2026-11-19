# Browser cookie response order

The question this fixture asks: when a browser holds copies of a session
cookie in more than one scope (Domain and host-only), or two replies that
write it race, which copy wins, and can any order leave the browser on the
wrong account?

## Rerun on the #7596 design (B7c)

`packages/web/e2e/browser-session/cookie-order.spec.ts` asks it again on the
design in [better-auth-browser-session.md](better-auth-browser-session.md), in
Chromium and WebKit, on the browser-session harness: https
`www.boardsesh.test` and `app.boardsesh.test` under one parent domain, the
production build of www, the real backend and PostgreSQL, under
`AUTH_BROWSER_SESSION_MODE=better-auth`. The edge in front of the servers
holds a reply after the server answered it and lets it go on release, so the
browser stores that reply's `Set-Cookie` only then, as a slow network would
deliver it (`holdResponse` in `partner-oauth-e2e/edge.ts`, the
`responseHolds` fixture). It runs on every pull request run of
`browser-session-e2e.yml` and nightly. Each case logs a `[cookie-order]` line
with the engine and what the browser ended with.

| Case | Rule of the design | Chromium | WebKit |
| --- | --- | --- | --- |
| Two logins in two tabs, A's reply held until B's login (from the app host) has landed | The login reply that arrives last wins; the other tab's login is gone; no data crosses accounts (accepted, #7596 item 1) | Ends on A on www and the app; one Domain login cookie, A's marker | Same |
| A held session read and ws-auth reply landing after B's login | Only logins and sign-out write the session cookie | Neither writes a cookie; B stays | Same |
| A host-only copy beside the Domain login cookie | Differing copies read as conflicted: signed out | Signed out on both hosts. Sends the Domain copy first | Signed out on both hosts. Sends the host-only copy first |
| Then a login on www | A login clears the host-only copy | Cleared; one Domain copy; B | Same |
| Then a login from the app host | A login clears the host-only copy | Cleared; one Domain copy; B | **Kept**: WebKit stores the Domain cookie from that reply but not the host-only clear, so the browser stays signed out (never A) until a login on www. `test.fail` (`WEBKIT_KEEPS_HOST_ONLY_COPY_ON_APP_LOGIN`); see below |
| A bridging session read held until after B's login | A login cookie outranks a bridged one | The bridged cookie lands; B on both hosts; no later read writes anything | Same |
| Apple: the resumed callback (the reply that publishes the sign-in) held until another account logged in | Last login wins (accepted) | Ends on the Apple account, one login cookie, its marker | Same |
| Apple: held until a newer Apple sign-in of the same account landed | Last login wins (accepted) | Ends on the held login of the same account | Same |

No order in either engine left the browser on an account other than the one
whose login reply arrived last, or signed out.

**The WebKit case.** It needs a host-only `__Secure-boardsesh.session_token`
on www beside the Domain one. Production www writes the session cookie with
`Domain=.boardsesh.com` whenever `NEXTAUTH_URL` is its own origin
(`sessionCookieDomain`), and the canonical-origin check stops a deployment
that is not, so only a misconfigured deployment could leave such a copy, and
a sibling host cannot set a host-only cookie for www. The result is a browser
signed out, not one on the wrong account. Whether to accept it, or to change
the design (for example, have the app send its login through a top-level
navigation to www), is an owner question raised on #7596.

The older proof (`cookie-order-browser.proof.ts`, the NextAuth cookie through
the legacy route exports, Chromium only, outside every CI job) is deleted. Its
renewal and set-password rows cannot happen on this design: neither writes the
session cookie, which acceptance 1 checks in both engines. Its Apple rows are
the accepted last-login-wins outcome above.

## The race on the NextAuth design (before #7596)

At integration commit `265310e046`, Chromium passed three successful-publication
controls and failed six later-login acceptance cases. A completed earlier A
response overwrote the later login for every tested response family:

| Completed response held before headers | Later other account | Later same user, new SID |
| --- | --- | --- |
| Public session renewal | Earlier A restored | Earlier A SID restored |
| Actual set-password replacement | Earlier A restored | Earlier A SID restored |
| Actual Apple callback | Earlier A restored | Earlier A SID restored |

That was the NextAuth cookie slot, which every session read rewrites. The
#7596 design answers it by writing the session cookie only from logins and
sign-out.

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
