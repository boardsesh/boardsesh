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

## Retired backend selection design

B5d removed the dark browser-binding core, its restricted-role proof and
`browser-binding.test.ts`. Its database tables and reviewed capability profiles
remain for migration compatibility. The removed private core was not a browser
publication fix. The current B7c replay and historical NextAuth race evidence
above remain relevant; see [the browser-session design](better-auth-browser-session.md).
