# Browser sign-in for www and the browser app

This is the design for BA-05 as re-scoped by
[#7596](https://github.com/boardsesh/boardsesh/issues/7596). The acceptance
criteria are in [#6979](https://github.com/boardsesh/boardsesh/issues/6979), the
epic is [#6975](https://github.com/boardsesh/boardsesh/issues/6975), and the
owner's rollout steps live in runbook
[#7430](https://github.com/boardsesh/boardsesh/issues/7430). Where this doc and
an older `docs/auth/better-auth-browser-*.md` disagree, #7596 and this doc win. The
older docs carry a "Superseded by #7596" banner and are deleted with their code.

The design in one sentence: one session cookie on the shared parent domain,
written by login and sign-out (and once by the read that bridges a pre-switch
cookie), plus one guard in each browser client's transport, with no
per-call-site wrapping.

Everything here was read on main `ac54f83751` (2026-11-16): the #7596 spec, the
code, and the installed Better Auth 1.7.17 and NextAuth 4.24.15 sources. File
and line references point at that checkout. Nothing was run for this doc.

## Status

Phase A and Phase B are built, dark, behind `AUTH_BROWSER_SESSION_MODE`
(production: unset, which is `legacy`). The PRs are listed on #7596.

**The cutover blocker lists are empty** since #7880: the backend's
`BROWSER_SESSION_CUTOVER_BLOCKERS` (`authority/browser-session-mode.ts`) and
www's `BROWSER_SESSION_WEB_CUTOVER_BLOCKERS` (`browser-session-mode.server.ts`).
What closed each entry:

| Entry | List | Evidence |
| --- | --- | --- |
| `B3_BROWSER_ACCESS_TOKEN` | backend | The coalesced per-request session read (`browser-access-token-burst.test.ts`); www and Expo web on the 15-minute token (`ws-auth-access-token.integration.proof.ts`, `use-ws-auth-token.test.ts`, `auth-browser-access-token.web.test.ts`); A's token refused after B signs in, both engines (`acceptance-2-account-switch.spec.ts`) |
| `B5_PROVIDER_SIGN_IN`, `B5B_WWW_PROVIDER_SIGN_IN` | backend, www | `web-oauth-session.test.ts` (backend), `web-provider-session.integration.proof.ts` (Google), `web-apple-sign-in.integration.proof.ts` (Apple), `provider-sign-in.spec.ts` (both, in Chromium and WebKit) |
| `B5E1_APPLE_LINK_PROOF` | www | `provider-security-apple-link.integration.proof.ts`; Apple link is on |
| `B6_PARTNER_CONSENT` | both | www calls the shared `isNewerLegacyLogin` and runs its vectors (`legacy-login-precedence.server.test.ts`), as the backend's consent reader does |
| `B7C_COOKIE_ORDER_FIXTURE` | both | `cookie-order.spec.ts`, Chromium and WebKit, every pull request run ([results](./better-auth-browser-cookie-order.md)); one WebKit finding left to the owner, below |

With the lists empty, `better-auth` starts when every precondition is met.
Nothing turns it on but the owner. Before setting it, the owner (runbook #7430):

1. **Secrets**, made fresh, each at least 32 bytes and all different:
   `AUTH_BROWSER_SESSION_COOKIE_SECRET` (www and backend),
   `AUTH_BROWSER_ACCESS_TOKEN_SECRET` and `AUTH_BRIDGE_TOKEN_SECRET`
   (backend), and `AUTH_LEGACY_BRIDGE_UNTIL` at most 45 days ahead.
2. **The staged modes**, on the backend and on www where both read them:
   `CURRENT_STORE_WEB_SESSION_MODE`, `_WEB_AUTH_MODE`, `_WEB_OAUTH_MODE` and
   `_SET_PASSWORD_MODE` at `backend-staging`,
   `CURRENT_STORE_WEB_CREDENTIAL_PROOF_MODE=required`,
   `AUTH_CUTOFF_ENFORCEMENT=enforce`, and, for Settings' link, unlink and first
   password, `CURRENT_STORE_PROVIDER_SECURITY_MODE` and
   `CURRENT_STORE_FIRST_PASSWORD_MODE` at `backend-staging` with
   `CURRENT_STORE_PROVIDER_GOOGLE_AUTH_TIME_MODE=auth-time-staging` on the
   backend ([rollout](./better-auth-rollout.md) has every value).
3. **`auth-authority activate`**, which still refuses on its two owner-only
   gates: `GARMIN_OFFLINE_TICK_QUEUE_PRESERVATION` (real-watch QA with the
   original signing key) and `HISTORICAL_WEB_ISSUER_RETIREMENT` (the old
   Vercel issuers confirmed retired). Until `activate`, no session is bridged
   or issued in production even with the mode on.
4. **Callback URLs**: register `/api/auth/provider-security/callback/google`
   with the Google client and `/api/auth/provider-security/callback/apple`
   with the Apple service id.
5. **Checks no harness can make**: real Safari (the seven-day cap on a cookie
   www sets from an app.boardsesh.com page; a back/forward cache restore),
   real Google (`max_age=31536000` brings `auth_time`; `max_age=0` with
   `prompt=select_account consent` forces a password), real Apple sign-in and
   link in Safari and Chrome (the form_post hold and resume; a second sign-in
   with no name), app.boardsesh.com signed in after a Google and an Apple
   return, and the partner consent page under the mode (not covered by the
   browser run; a follow-up).
6. **Decide the WebKit finding** (#7880, `cookie-order.spec.ts`): WebKit keeps
   a host-only login copy on www after a login sent from the app host, so such
   a browser stays signed out until it logs in on www. Production www should
   never write a host-only copy; accept, or change how the app sends its login.

Turn the mode on in the backend first, then www; roll back www first.

## What a climber notices

After Phase A, an open www tab clears its cached data and reloads at the home
page in the climber's language when another tab or the browser app signs in as
someone else or signs out. On app.boardsesh.com any account change after the
page first showed an account reloads the app, including signing out in that
tab. A response for the old account shows nothing, so no stale toast or
redirect appears. After Phase B, sign-in looks the same and a climber signed in
before the switch stays signed in. Native iOS and Android apps and Garmin do
not change in either phase.

## The session cookie

| | Today (NextAuth 4.24.15) | This design (Phase B) |
| --- | --- | --- |
| Name | `__Secure-next-auth.session-token`, or `next-auth.session-token` outside a secure context (`packages/web/app/lib/auth/secure-cookies.ts:16-17`) | A Better Auth signed cookie with its own prefix (below) |
| Domain | `.boardsesh.com` when serving www or the apex in production; host-only on previews and local (`secure-cookies.ts:57-77`) | The same, through Better Auth `crossSubDomainCookies`, enabled only where `sessionCookieDomain()` returns `.boardsesh.com` |
| Attributes | HttpOnly, SameSite=Lax, Path=/, Secure in a secure context (`auth-options.ts:263-279`) | The same |
| Lifetime | 30 days, rolling (`next-auth/core/init.js:45`) | Open question 1 |
| Written by | Login, sign-out, and every session read: each GET re-encodes the JWE and sets the cookie again (`next-auth/core/routes/session.js`) | Login and sign-out responses, and the one session read that bridges a legacy cookie (B2) |

Session reads, renewal, set-password and provider link emit no `Set-Cookie`
for the session, apart from the bridging read. Set-password and provider link
keep the session and its token. With this configuration nothing rolls the
session: `disableSessionRefresh` also stops Better Auth extending
`auth_session.expires_at`, because its `updateSession` call sits behind the
same `needsRefresh` flag (`api/routes/session.mjs:181-183,198-202`). B1 rolls
`expires_at` in its own code or chooses an absolute lifetime (open question 1).

How Better Auth is kept from writing the cookie on reads (read in
`better-auth/dist`, not run):

1. `session.disableSessionRefresh: true` turns off the refresh on a session
   GET (`session.mjs:181`). `deferSessionRefresh` is the wrong option, because
   its POST path still writes the cookie.
2. `cookieCache` stays off, as `createAuthority` already sets it
   (`authority.ts:48`). `setCookieCache` then returns at once
   (`cookies/index.mjs:77`), so no `session_data` cookie is written.
3. Better Auth still clears the cookie when the session is missing or expired
   (`session.mjs:156`), when a refresh update fails (`:207`), and when a stale
   `session_data` cookie arrives (`:43-46`), and no option turns that off. An
   after-hook removes those `Set-Cookie` lines. After-hooks run even when the
   handler throws, and the dispatcher returns the hook-edited headers
   (`api/dispatch.mjs:247-248`). Routes behind the session middleware copy the
   inner read's `Set-Cookie` (`session.mjs:268-271`), so the hook covers every
   route, not only `/get-session`.
4. The www forwarder strips the same lines again, and the browser tests in B7
   assert that no `Set-Cookie` arrives.

The cookie needs its own prefix. The partner OAuth instance on
api.boardsesh.com sets no `cookiePrefix` (`partner/authority.ts:174-218`), so
it uses Better Auth's default `better-auth` (`cookies/index.mjs:28`). A
first-party cookie on `Domain=.boardsesh.com` also reaches api.boardsesh.com,
so the two must not share a name, and the name must differ from both NextAuth
names, because the legacy cookie stays for 30 days. B1 picks the prefix.

The scope does not change. Per #7596 the cookie reaches www, the apex, app,
ws, api, the R2 buckets, updates, `{N}.preview` and `{N}.ws.preview` (live DNS
not checked). Preview hosts are the only ones that can run unreviewed code, so
they stay on manual dispatch or move to a separate domain.

The backend (`packages/backend`) owns sessions, the legacy bridge, the browser
token and revocation. www keeps `/api/auth/session`, `/api/auth/csrf`, the
credentials callback and guarded sign-out at their URLs and JSON shapes, and in
`better-auth` mode forwards them to the backend (B4). Server renders never set
a cookie. Expo web learns everything from www responses, as it does today.

## The browser token

Browser JavaScript holds the raw 30-day NextAuth JWE today:
`/api/internal/ws-auth` returns it in JSON (`ws-auth/route.ts:81-86`), and www
and Expo web send it to the backend as a bearer. B3 replaces it with a token
that lives 15 minutes (owner decision 14, which is not written down anywhere on
main; #7596 is the record). It is not the session token, so Better Auth's
`bearer` plugin, which copies the session token into a `set-auth-token` header
(`plugins/bearer/index.mjs:64-65`), is not used.

Every request made with the token checks that its session is still live. The
BA-04 admission read already joins `auth_session_denials` per request
(`packages/backend/src/auth/human-admission.ts:89-116`), but it only sees
sessions ended through `denyFirstPartySession*` (`authority/lineage.ts:50-69`).
A row removed by Better Auth's own `deleteSession` leaves no denial, so B3 also
confirms the `auth_session` row exists and has not expired, or every
revocation goes through `lineage.ts`.

### What B3a built (backend, dark)

- **The token** (`authority/browser-access-token.ts`): an HS256 JWS, audience
  `boardsesh-browser`, issuer `boardsesh`, claims `sub`, `sid`, `gen`, `sexp`
  (the session row's expiry), `link_guarded`, and `auth_time` only for a
  `login` session. `exp` is the earlier of `iat` + 900 s and the row's expiry.
  The key is HKDF-SHA256 of `AUTH_BROWSER_ACCESS_TOKEN_SECRET` (label
  `boardsesh-browser-access-token-key-v1`), derived once per secret value.
  Verification pins HS256 (so never `none`), the audience and issuer, 30 s of
  clock skew, a lifetime of at most 900 s, and requires every claim with its
  type; `sexp` and `link_guarded` are never trusted (the session read decides
  expiry and sign-in proof).
- **The token endpoint**: `POST …/web-session/v1/access` with `{ presented }`
  (see the command table). It is the only place a session rolls (the separate
  `/roll` command is gone; nothing on www called it): it reads the session,
  rolls it when under 29 days remain, reads it again and signs a token for what
  the second read admitted; `rolled: true` is never taken as liveness. A legacy
  cookie gets `401 unauthenticated` with `reason: 'bridge_required'` and is not
  read; a dead cookie gets `reason: 'no_session'`.
- **Requests** (`validateToken` in `middleware/auth.ts`): only while
  `CURRENT_STORE_WEB_SESSION_MODE=backend-staging`, a three-segment token of at
  most 4,096 characters whose unverified audience is `boardsesh-browser` goes to
  the browser verifier; the mode is checked first, so with it off no token is
  decoded and every token takes the app path exactly as before. Each request
  then reads the session by id in ONE statement on the auth admission pool,
  through a coalescer keyed by session id that shares its two read slots with
  the account read (`docs/operations/db-connectivity.md`, "How much can queue on two
  connections")
  (`auth_session` and its lineage by primary key, the account, its cutoff row
  and a denial of this id) and applies exactly the cookie read's row and
  account rules (`canonicalFirstPartySession`, `admitsFirstPartySession`), plus
  the token's account and generation. So sign-out, a login that revoked it, a
  reset, set-password on that session, deletion, a no-SID cutoff and a revoked
  lineage refuse it at once. Unlike the older kinds, a token that claims this
  audience but does not verify (expired, tampered, another key) is refused with
  401, not read as anonymous; a payload that does not even decode claims no
  audience and takes the app path, as any foreign token does. No result is
  cached. `credentialExpiresAt` is the session's expiry (notification-device
  leases), and `webSignIn` carries a sign-in time only for a `login` session.
- **WebSockets**: the admission sweep also reads the sessions its browser
  sockets were opened with (one admission read per 128 ids, one at a time,
  after the account read) and closes a socket
  whose session is no longer live or no longer the token's (4401). A token
  that expires mid-connection closes the socket at the next operation, as the
  older kinds do, and the client reconnects with a new one.
- **Cost per request**: one primary-key statement on the bounded auth
  admission pool (2 connections per replica, 1 s deadline) instead of the
  older kinds' account read, shared by every request that asks in the same
  tick; no result cache, by design.

### ws-auth and the two browser clients on the token (B3b)

Under `AUTH_BROWSER_SESSION_MODE=better-auth`, `/api/internal/ws-auth`
answers the 15-minute token instead of the raw NextAuth JWE
(`browser-access-token-route.server.ts`). With the mode unset, empty or
`legacy` it is the code it was; `ws-auth-access-token.integration.proof.ts`
pins that answer from before the change. Another mode value is 503.

Who the browser is comes from `resolveBrowserSession`
(`browser-session-bridge.server.ts`), the one resolver the session read uses
too: same precedence, same conflict and oversize rules, same newer-legacy-login
rule. So `userId` and `authSessionId` in ws-auth always equal what
`/api/auth/session` answers for the same request, fallbacks included. The
session read turns the answer into session JSON and its planned cookie writes;
ws-auth writes and clears no cookie at all, in any case. ws-auth then calls the
backend `access` command with the canonical token the resolver found.

| Case | ws-auth answer |
| --- | --- |
| A live session (from the cookie, or bridged) | 200 `{ token, authenticated: true, userId, authSessionId, expiresAt, expiresIn }`; `expiresAt` is the token's end, at most 15 minutes away, and `expiresIn` the seconds left by the server's clock, which clients time their refresh by from receipt |
| No session cookie, a conflicted one, an oversized legacy cookie, a plain-named legacy cookie in a secure context, or a legacy login the bridge denies | 200 `{ token: null, authenticated: false }` |
| A first-party cookie whose session ended (the session read answers `{}` with the `denied` header) | 401 `{ token: null, authenticated: false }`; never a fall back to the legacy cookie |
| A legacy-only browser | Bridged without a cookie (the bridge is deterministic, so the next session read sets exactly that cookie), in its own budget of 20 a minute per client address (`ws-auth-bridge:`), then the token as above |
| An unverifiable first-party cookie (bad signature, either name) beside a valid legacy cookie | Bridged without a cookie, as above. The session read does the same and never writes a cookie for this browser: the bridged session's JSON with the legacy cookie's `authSessionId`, `{}` with nothing cleared when the bridge is denied, and 503 when it fails |
| Bridge over its budget or failing (legacy-only), backend 503, an unparsed reply, the transport's 401 | 503; the client keeps its session and backs off |

Two states changed for the session read with this (#7792 review, M4): a
plain-named legacy cookie in a secure context reads `{}` from the shared
resolver rather than from the legacy path (same body; NextAuth reads only the
`__Secure-` name in production today), and an unverifiable first-party cookie
beside a valid legacy cookie is bridged without a cookie write instead of
answered from the legacy path.

Costs: a signed-in ws-auth is two private commands (`session`, then
`access`); a bridging one is four. The www hook refreshes about every 12
minutes per tab, and the provider's identity probe calls ws-auth on focus at
most once every 30 seconds.

**www** (`app/lib/auth/browser-access-token.ts`, `use-ws-auth-token.ts`). The
token lives in memory only (React Query data, never persisted). Everything is
timed from when the tab received the token, by `expiresIn`, never from the
client clock against `expiresAt`. It goes stale three minutes before its end,
less a jitter of up to 30 s chosen per token, so the hook refetches at about 12
minutes, and on focus or `pageshow` only once fewer than three minutes remain;
every caller shares one fetch per tab, and every mounted hook registers its
refetch, so closing any one component never stops the tab's refresh. A failed
refresh (503, timeout) keeps the token and waits 30 s, then 60 s, doubling to 5
minutes per failure, with no quick retries; nothing signs out. A ws-auth 401
asks the session read once; if that still shows the same login, later 401s
only back off (the provider's probe does the same). The session guard sends a
request the backend refused with 401 once more with one new token, fetched
once per refused token for every caller; a second refusal goes to the session
check. A socket is keyed by a handle that stays the same while the viewer does
and reads the current token at each (re)connect. graphql-ws gives up on a 4401
close before it asks `shouldRetry`, so a browser-token socket's class turns the
4401 into a retryable close after marking the token it connected with; the
reconnect sends a new token and graphql-ws resubscribes. A 1013 reconnects
with the same token. A legacy token's socket still closes on 4401. An account
change or sign-out seen by the guard drops every token, and the guard closes
the shared socket. After set-password the page asks for a new token at once. A
token without `expiresIn` (legacy mode) is never remembered, so with the mode
off requests and sockets send what they sent before.

**Expo web** (`.web` files only: `auth-store.web.ts`,
`auth-interceptor.web.ts`). A ws-auth answer with `expiresIn` is refreshed
about three minutes before its end (less up to 30 s of jitter), counted from
receipt, through the one shared session read (`synchronizeWebSession`). Every
outcome of that read feeds one backoff (30 s doubling to 5 minutes), which the
timer, `ensureFreshToken` and focus all honour, so neither an outage nor a
fast clock reads the session before every request. The timer does not run in
a hidden tab: it refreshes when the tab is shown. Focus refreshes the token
inside the last three minutes despite the 30-second throttle, unless a failed
refresh is backing off, and a focus probe that brings a token for the same
login replaces the page's own. `ensureFreshToken` keeps a token that has not
ended when a refresh fails. The existing 401 path (one shared refresh, one
retry) and 4401 path (refresh, then reconnect) are unchanged. A ws-auth 401
inside the session/token pair reads the session again. The legacy JWE has no
lifetime and is used as before.

Provider link and unlink have no www page under this mode yet (B5e); they
should call `refreshAccessTokenAfterCredentialChange` as set-password does.

### Server renders and private routes (B4a)

`getAdmittedServerSession()` and `getServerAuthToken()` keep their signatures
(`admitted-session.server.ts`, `server-auth.ts`), so every page, server action
and `/api/internal/*` route that reads the viewer moves with them, including
the three cookie-only routes behind the expected-viewer check (`controllers`,
`profile`, `profile/[userId]`), set-password's identity read, `join`, the
admin check and the feature-flag distinct id. With the mode unset, empty or
`legacy` both read the admitted NextAuth cookie exactly as before: the mode is
checked from the variable first, and nothing new is even loaded.

Under `better-auth` both come from `server-browser-session.server.ts`: ONE
`resolveBrowserSession` per request, with its access token, held in a WeakMap
keyed by the request's headers object (`headers()` gives every helper call of
one request the same object, in a page render, a route handler or a server
action, and the entry goes with the request). React's `cache` is not relied
on: it memoises only inside a page render. The resolver gets the request's
`Cookie` header exactly as received, never one rebuilt from `cookies()`,
which keeps one copy per name and would hide the duplicate copies that mean
signed out. So session and token always come from one resolution, and a
request costs one `session` command and one `access` command (a legacy-only
read adds one `bridge` and one more `session`).

Only reads bridge a legacy-only browser without a cookie: a page render or
any request whose method is GET or HEAD. A route handler passes its method
(`getAdmittedServerSession({ method: request.method })`), and a server action
(Next's `Next-Action` header) counts as a write. A write with only a legacy
cookie is answered from the admitted legacy cookie, as the session read
answers a POST, or 503 when that cookie cannot be admitted.

| The resolver says | Session | Token |
| --- | --- | --- |
| A live session (from the cookie, or a legacy-only read bridged without a cookie) | The session JSON's fields in NextAuth's `Session` shape | The 15-minute access token for that same session |
| Signed out (no cookie, a dead, conflicted or duplicated first-party cookie, an oversized or plain-named legacy cookie, a denied bridge), or `access` finding the session ended | `null` | `undefined` |
| Nothing known beyond the legacy cookie (its bridge over budget or failing, or a write) | The admitted legacy cookie's session, as the session read answers then | The admitted legacy cookie, as in `legacy` mode (the backend still accepts it) |
| Backend unavailable, or an unknown mode value | `CredentialAuthorityUnavailable`, which each route already answers as its error (503), never as anonymous | the same |

Because `access` is part of every resolution, a request never has a session
without a token: an `access` that finds the session ended makes the request
signed out. A browser whose first-party cookie never verifies beside a valid
legacy cookie can never get a cookie written and is bridged on every read;
its bridges count in their own budget of 120 a minute per client address
(`COOKIELESS_BRIDGES_PER_CLIENT`) rather than the 20 of a legacy-only browser,
so link prefetches do not turn into an outage of its own.

A render never writes or clears a cookie: the legacy-only browser's first
document arrives before any session read and renders signed in from a
cookie-less bridge; the session read that follows sets exactly that bridged
cookie. The rollback twin beside a login cookie is never preferred: the
resolver reads the login cookie first. The token never leaves the server: no
page passes it to a client component, into an RSC payload or into cacheable
HTML, and the client store only ever holds tokens from ws-auth.

Private commands per page view under `better-auth`: the render sends one
`session` and one `access` (a legacy-only first document adds one `bridge` and
one more `session`); the page's own session read sends one `session`, and its
ws-auth two. These are www-to-backend commands, each one admission read on the
backend (#7787's coalescer covers the per-request token reads that follow).

The native transfer callback (`api/auth/native/callback`, where the app's
browser sign-in ends and the app's transfer token is minted) reads the same
request resolution under `better-auth` since B4c-web: the account, session id,
generation, sign-in time and link guard of the token come from the canonical
session (see "The native app's transfer token under `better-auth`"). The
provider link guard (`oauth-link-guard.server.ts`)
reads the cookie NextAuth's own provider callback links into, which stays the
legacy cookie until B5. The partner sign-in and consent pages read the same
request resolution (sign-in time and link guard from the session row, as
partner consent does on the backend since B6). In the one state where the two
could name different accounts (a stale first-party cookie beside a newer
legacy login whose bridge failed now; the backend follows the newer login),
the page shows no account and asks for a sign-in.

## Signed-in browsers from before the switch

A browser with a valid legacy JWE and no new cookie is bridged by the private
command `POST /api/internal/auth/current-store/web-session/v1/bridge` (B2a,
`bridgeWebSession` in `authority/web-session.ts`, over
`bridgeLegacyCredential`), which keeps the legacy `authSessionId` as the new
session's id. The www session read sets the new cookie on that response (B2b).

The bridged token is derived, not random (owner decision 3):
base64url(HMAC-SHA256(key, "boardsesh-bridge-token-v1:" + sessionId)), the key
derived by HKDF-SHA256 from `AUTH_BRIDGE_TOKEN_SECRET` (`session-token.ts`).
So the same legacy login always bridges to the same token and one row, a lost
reply is recovered by bridging again, and two concurrent bridges both get a
usable token. The row still stores only the digest. The secret is the
backend's alone: `NEXTAUTH_SECRET` and the cookie secret are also on www, and
the access-token secret verifies short tokens and should stay free to rotate.

What the bridge denies, writing nothing: a cookie that does not verify or has
expired; a deleted or missing account; a cookie stamped with another
generation than the account's, where a missing stamp counts as 0 (so a cookie
from before any password change is denied once the generation has moved); a
session id that was signed out (its denial row); a revoked lineage; and a
session id that already names a row the bridge did not make from this login: a
`login` row, a `carried:` row (every rollback cookie a post-cutover login
writes, since proof and session share one id), or a bridged row whose token
the current key does not derive. The browser then signs in again.

The bridge writes only under an enforced manifest with the configured
projection id and writer epoch, as login does; otherwise it answers 503 and
writes nothing. It runs under the commands' 5-second statement and 4-second
lock timeouts, so a bridge queued behind a held account (a reset, a deletion)
answers 503 instead of holding a connection. Renewing a row from a later
cookie never shortens it: the update re-checks the expiry under the row lock,
so a roll that committed in between wins.

A legacy cookie without a session id follows the bridge's existing rule: it is
bridged as its own row, never by an account cutoff. The row id is the
cookie's lineage id, `credential:` + sha256 of the JSON
`["nextauth-v4", userId, sha256(cookie)]`, where the cookie is hashed in its
canonical form (each of the five segments re-encoded from the bytes jose
decrypted), so `=` padding, whitespace, a trailing newline or different unused
bits in a last character do not make a second session. A genuine NextAuth
cookie, and a chunked one www joins, is already canonical, so its id does not
change. A cookie that carries `authSessionId` and `legacy_no_sid: true` keys
its row by that session id and its lineage by a hash of it, so its renewals
share one row. Such a row ends alone, never by a cutoff: sign-out by its
token; sign-out presenting the raw cookie; and a login presenting either one
ends the row the bridge made from it (exact id and lineage), if any, and
nothing else.

### If `AUTH_BRIDGE_TOKEN_SECRET` leaks

Rotating the secret alone ends no session: each bridged row keeps the digest
of the token it was given, and the leaked key with a session id still derives
that token. The owner runs these steps; agents prepare them.

1. Count the web-bridged rows (read-only):

   ```sql
   SELECT count(*) AS bridged, count(*) FILTER (WHERE expires_at > now()) AS live
   FROM auth_session
   WHERE (legacy_lineage_id LIKE 'session:%' OR legacy_lineage_id LIKE 'credential:%')
     AND legacy_lineage_id NOT LIKE 'credential:native-refresh:%';
   ```

2. Set a new `AUTH_BRIDGE_TOKEN_SECRET` on the backend and redeploy.
3. Delete exactly those rows, in one transaction, and check the count matches
   step 1 before committing. Every browser bridged before then signs in again;
   a legacy cookie it still holds bridges to a new token under the new key.
   Native refresh rows (`native-refresh:` and `credential:native-refresh:`) and
   login or carried rows are untouched.

That bridging read is the one read that writes the cookie, so the cookie-order
race comes back once for every browser signed in before the switch. Tab 1's
read starts bridging A. Tab 2 logs in as B, and that login revokes the
presented legacy session, which has the same id as the bridged one. Tab 1's
delayed response then installs A's revoked cookie over B's, and B is signed
out, which #6979 criterion 3 forbids. Open question 3 lists the options.

Every legacy cookie shape must bridge: the normal `__Secure-` cookie, chunked
cookies (`<name>.0`, `<name>.1`, ...), a host-only cookie left from before the
shared domain, and the plain-named `next-auth.session-token`
(`secure-cookies.ts:80-101,133-151`). When a browser sends a host-only and a
domain cookie with the same name and different values, the backend's strict
reader returns nothing (`legacy-web-credentials.ts:186`), so the www forwarder
has to choose which copy to bridge. B2 needs a test for that case.

The legacy cookie is kept for 30 days after cutover (owner decision 23,
recorded in #7596), so a browser signed in before cutover needs no cookie
clearing on rollback. Logins after cutover are open question 4.

#7596 says a bridged session never counts as a fresh sign-in, so set-password
and provider link or unlink on it need real reauthentication. The bridge on
main sets `createdAt` to the legacy `auth_time` for a link-guarded cookie and
to epoch 0 otherwise (`bridge.ts:82`). With `freshAge` at 300 seconds
(`authority.ts:47`, compared at `session.mjs:337-340`), a bridged cookie from a
sign-in under five minutes old counts as fresh. That follows
[the accepted migration](better-auth-migration.md) at lines 207-213 ("preserve
trustworthy age"). The owner decided on 2026-11-17 (decision 3): a bridged
session keeps that time for the 30-day rules and fails every five-minute check.
The reader now carries that as `source` (see "The backend session interface").

## Login revokes the session it arrived with

When a login request carries a session cookie, legacy or new, the login
revokes that session in the transaction that creates the new one. For a
session with an SID, B1 reuses `denyFirstPartySessionInTransaction`
(`lineage.ts:61`), which deletes the `auth_session` row and writes the
`auth_session_denials` row the admission read checks (`lineage.ts:144-165`). A
request still carrying the old account's browser token then gets a 401, so the
other tab re-reads the session and reloads as the new account (acceptance
item 2).

A legacy cookie without an SID, or one marked `legacy_no_sid`, takes another
path. NextAuth sets that mark on every cookie from before SIDs existed and
keeps it across rotations (`auth-options.ts:476-479`), and the backend reader
then sets `requiresAccountCutoff` (`legacy-web-credentials.ts:138`). Without an
expected authority the denial throws `AUTHORITY_NOT_ENFORCED` (`lineage.ts:80`),
so the login would fail. With one, it records an account-wide sign-out,
expires every `auth_session` row and revokes every `mobile_refresh_tokens` row
for that user (`lineage.ts:99-135`), which signs the previous account out of
its phones. Open question 5 decides what a login does with such a cookie.

Stock Better Auth sign-in returns the raw session token in its JSON body
(`api/routes/sign-in.mjs:364`). Stock sign-out clears the cookie even when the
database delete failed (`api/routes/sign-out.mjs:49-54`), checks no expected
identity and writes no denial row. Neither is used as is. B4 keeps today's
guarded sign-out, which answers 409 when the cookie no longer belongs to the
identity the tab expected (`[...nextauth]/route.ts:243`).

## The backend session interface

Owner decision 1 (2026-11-17) splits issuance at the session row: the backend
writes and rolls `auth_session` rows, and B1 owns the cookie. The backend half
is `packages/backend/src/auth/authority/web-session.ts`. No route mounts it
directly, and it sets no cookie or header.

`issueWebSession(transaction, { userId, authenticatedAt, freshness?, presented?, now, authority })`
returns `{ sessionId, token, expiresAt, generation }`.

- It runs inside the transaction that verified the credential. It verifies
  nothing itself. A caller that takes `users` row locks before calling must
  take the signing-in account's row and the presented account's row in one
  pass, in `users.id` order, with the exported `lockWebSessionAccounts`
  (FOR KEY SHARE and FOR UPDATE). A caller that holds only KEY SHARE on its own
  row and then calls deadlocks against a crossed login: each holds its own row
  and waits FOR UPDATE on the other's. The staged password command uses the
  helper.
- `authority` is the receipt the caller captured before bcrypt. A writer switch
  since then is refused with `STALE_AUTHORITY`, as the staged password command
  refuses it. So it works only once the manifest is `enforced`, like every
  staged writer.
- Locks: the shared (6975, 2) gate and a manifest re-check, then the `users`
  rows in `users.id` order (FOR KEY SHARE for the account signing in, FOR UPDATE
  for the presented session's account), then the presented session's rows,
  then the new row. Two logins that present each other's sessions queue on the
  first `users` row instead of deadlocking.
- It writes one row: a random UUID id; a token of 32 random bytes in base64url
  from `newSessionToken()`, of which the row stores only the SHA-256 digest, as
  every first-party writer does (the reader hashes a presented
  `canonical-token` and looks the digest up), and the raw token goes back only
  in this call's return value; `expires_at` =
  `now` + 30 days; `original_authenticated_at` = `authenticatedAt`; no
  `legacy_lineage_id` for `freshness: 'login'` (the default); and
  `revocation_generation` = the account's generation.
- `freshness: 'carried'` is for a sign-in made elsewhere (a native transfer, a
  provider sign-in without a verified `auth_time`). The row keeps the sign-in
  time for the 30-day rules but stores `legacy_lineage_id = 'carried:<id>'`,
  which names no lineage row, so it reads as `bridge` and never passes a
  five-minute freshness check. No new column.
- `presented`, of any account, legacy cookie or canonical row, must be the
  session `readFirstPartySession` admitted in this transaction. One with its
  own session id is revoked in the same transaction by
  `denyFirstPartySessionInTransaction`: it loses its row and gets a denial, so
  every reader refuses it. One that `requiresAccountCutoff` (a no-SID legacy
  cookie, or the bridged row of one) ends by its own id alone: the row the
  bridge made from it, if any, and a denial of that id (#7596 B2c). It is never
  ended by cutting off the whole account, phones included, so a login never
  does that and never moves the generation.
- It refuses before writing anything: a deleted or missing account with
  `AuthSubjectDeniedError`, as native issuance does, and a sign-in time later
  than `now` or an unknown `freshness` with `INVALID_COMMAND`. So a caller that
  catches the refusal inside its transaction still commits nothing.

`rollWebSession(database, sessionId, now)` returns `{ rolled: true, expiresAt }`
or `{ rolled: false }`. It is one conditional UPDATE that sets `expires_at` to
`now` + 30 days when fewer than 29 days remain and the row is live: unexpired,
no denial, a generation equal to the account's, an account not deleted, and a
lineage (if any) that is unrevoked and names this row. It writes no cookie.
Bridged web rows roll too. The bridge still caps a new row at the legacy
cookie's expiry; the first roll lifts that to `now` + 30 days, and re-bridging
never shortens a row. Nothing here tests "bridged" by a non-null
`legacy_lineage_id`: a `carried:` row has one too. The roll skips only native
refresh lineages, and the bridge matches the exact lineage id of the cookie. A revoked lineage stops the roll, and
sign-out still deletes the row and writes the denial. Rows bound to a native
refresh token keep that token's expiry and never roll. A roll never makes a row
readable: every reader checks the same conditions itself. `rolled: true` is not
proof the session is live: a roll queued behind an account cutoff re-checks
only the row it waited on, so it can extend the expiry of a row the cutoff just
ended, which the reader then refuses by its generation. B3 relies on the
reader, never on the roll's result.

Constants, in `@boardsesh/auth-protocol`: `WEB_SESSION_LIFETIME_SECONDS`
(2,592,000, 30 days) and `WEB_SESSION_ROLL_BELOW_REMAINING_SECONDS` (2,505,600,
29 days).

Session source. `readFirstPartySession` returns `source: 'login' | 'bridge'`,
derived from the row (`login` when `legacy_lineage_id` is null) with no new
column. A NextAuth cookie read directly is `login`, as it is the legacy login
itself. `requireFreshAuthentication` passes only for `login`.
`webSignInProof(session)` is the `webSignIn` value B3 must set when a canonical
session authenticates a request; it carries no sign-in time for a `bridge`, so
partner app changes refuse it. The 30-day partner-consent rule reads
`authenticatedAt`, which a bridged row keeps. Partner consent (B6) reads the
first-party cookies before the legacy one while `CURRENT_STORE_WEB_SESSION_MODE`
is on; the order, the stale-cookie rule and the 503 are in
[integration-platform.md](../integrations/integration-platform.md), "Who is signed in". Provider link and unlink need
their own reauthentication receipt (`provider-reauthentication-evidence.ts`),
never the session's age, so they did not change. Since B5c1, provider security
compares the actor on session id and generation, not expiry, so a link that
spans a roll goes through. First password does the same since B5c2.

What B1 does with the token: put it in the signed session cookie, Max-Age
34,560,000 (decision 2), only after the command answers; never log it or hand
it to page JavaScript. Reads present it back as a `canonical-token` after the
cookie signature check.

### Set-password on a canonical session (B4b)

The staged set-password command (`POST /api/internal/auth/current-store/set-password`)
also takes `{ presented, expectedUserId, expectedAuthSessionId, password,
confirmPassword }`; the first form with `credential` is unchanged, and a
presented legacy cookie behaves exactly as that form. With
`CURRENT_STORE_WEB_SESSION_MODE` on, a canonical token sets the password only
for a `login` session signed in under five minutes ago; a bridged or carried
session, or an older login, answers `reauthentication_required` and writes
nothing. On success the account's generation moves and the session keeps its id
and token at the new generation (`keepCanonicalAfterSecurityMutation`, the same
function the provider flows use), so www writes no cookie; every other session,
lineage, native refresh token and pending link ends as before. The reply is
`set` with a credential proof at the new generation and no token. That proof
carries `authenticatedAt: null` and `linkGuarded: false`: www must not write a
cookie from it, and it stays in the reply only because the reply schema (and
www builds already deployed) require one; written by mistake, it could never be
fresh.

Accepted with this design:
- A stolen copy of the requesting session's token survives the password change,
  because the session keeps its token. Every other session ends.
- After set-password the browser's legacy rollback twin is stale (its generation
  is the old one) and no cookie may be written, so after a rollback that browser
  signs in again. A browser
access token signed before the change is refused at once; `/access` signs a new
one for the same cookie. With the mode off a canonical token answers
`unauthenticated`.

### Native transfer sign-in in a browser: refused under `better-auth`

www's `native-oauth` credentials provider signed a browser in with a native
OAuth transfer token. Nothing has called it since 2026-08-15: the Capacitor
deep-link listener that used it was deleted (d5a8336c88), and the Expo app
exchanges the token at the backend's `/auth/native/exchange` and never used the
provider. So there is no backend command that turns a transfer token into a web
session, and under `AUTH_BROWSER_SESSION_MODE=better-auth` www refuses the
`native-oauth` provider instead of minting a NextAuth session no backend
session stands behind: its `authorize` answers the existing failure before any
work, with no backend call and no cookie change (B4c-web).

### The native app's transfer token under `better-auth` (B4c-web)

`/api/auth/native/callback` stays live in every mode: every app sign-in ends
there, in the app's browser, and the page mints the transfer token the app
exchanges at the backend. Under `better-auth` it reads the request's one
canonical resolution (a legacy-only browser is bridged without a cookie) and
signs the token from it: account, session id and generation, the same values
the session read and partner consent see. The sign-in time and the link guard
go into the token only for a real login (`source: "login"`); a carried session
(every Apple sign-in, a silent Google one) or a bridged one hands the app
neither, as the 15-minute browser token drops them too. A signed
out browser answers `session_missing`; a request known only by its legacy
cookie (its bridge over budget or failing) or a backend outage answers
`session_unavailable`.

The legacy cookie is still read for one thing: the account-creation receipt
(`nativeOAuthCreationProof`) a Google or Apple sign-in puts on its legacy twin,
which no session read carries. It is used only when that cookie names the same
login (`sub` and `authSessionId` equal the canonical session's). A legacy cookie
of any other login, or one that does not decode, refuses the token
(`token_issue_failed`): the page never mixes two logins. The backend change
that would end this read: the web OAuth `resolve` command knows whether it
created the account, so it would store the receipt (provider, creation time,
sign-in time) with the session it issues, and the session read would return it
while that sign-in is minutes old.

A browser still holding a legacy cookie without a session id is refused here:
its bridged row's id is `credential:<hash>`, which never equals the cookie's own
(absent or assigned) `authSessionId`, so the twin check fails. The app flow does
not reach that state, because a sign-in always comes first and rewrites both
cookies. The app's native session always gets its own new id at the exchange;
the source session id in the token is only checked once there, for a denial.
With the mode unset the page answers byte for byte as before
(`native-callback.integration.proof.ts` pins status, headers, body and the
token's claims, with the mode unset, empty and `legacy`, and with proofs
required).

### Set-password on www under `better-auth` (B4b-web)

`/api/internal/set-password` presents the request's one resolution (the one the
route already read its viewer from) to the staged command's `presented` form,
canonical token only, with that resolution's user id and session id as the
expected login. Outcomes:

- `set`: the proof's user and session ids are checked against the session and
  the proof is dropped; the answer is `{ "outcome": "set" }` with no
  `Set-Cookie` at all. The card asks for a new 15-minute token at once
  (`refreshAccessTokenAfterCredentialChange`) and stays signed in, with no
  reload. The old token is refused from then on.
- `reauthentication_required` (a bridged or carried session, or a login over
  five minutes old): 403 and nothing written. The card offers today's way back
  in: sign out, then the login page with the password and Google buttons and a
  callback to Settings. A forced Google reauthentication arrives with B5e1;
  until then a Google sign-in the browser completes silently is `carried` and
  is asked again.
- `already_set` (a retry after a lost reply, or a password another tab set):
  409 with `code: "already_set"`. The card never claims this password was
  saved: it switches to its "password login is enabled" state, and asks for a
  new 15-minute token, as the earlier write moved the generation.
- `identity_changed`, or a body naming another login than the cookie: 409 with
  `reload: "root"`; the card reloads from the locale root.
- A request known only by its legacy cookie (the page's own session read bridges
  first, so this means the bridge is over budget or failing, or never sets a
  cookie): 403 `reauthentication_required`, nothing written, the legacy cookie
  never acted on. Not "try again", which such a browser would never get past.
- A lost or failed reply: 503 and no cookie change.

After a rollback, a browser that set a password since cutover signs in again:
its legacy twin is at the old generation.


### The private commands B1 calls

All five sit behind `CURRENT_STORE_WEB_SESSION_MODE=backend-staging` on the
backend (404 `{ "error": "disabled" }` when off, 503 for an unknown value), use
the existing `Authorization: Bearer <CURRENT_STORE_AUTH_RPC_SECRET>` and refuse
any request carrying an `Origin` header. Schemas and types are in
`@boardsesh/auth-protocol` (`web-session.ts`).

| Command | Request | Replies |
| --- | --- | --- |
| Login: the staged password command, `POST /api/internal/auth/current-store/password` | `passwordCommandSchema` plus `webSession: { presented? }`. `presented` is `{ kind: 'legacy-jwe', credential }` (the joined NextAuth cookie) or `{ kind: 'canonical-token', token }` (from the new cookie). There is no field for an account: the session goes to the account the password proves. | `authenticated` with `webSession: { sessionId, token, expiresAt, generation }`; `invalid_credentials` with nothing issued and nothing revoked. An account that still needs email verification gets `authenticated` with `verification.verified: false` and no `webSession`, and its presented session stays. Rate limits and the compare gate are those of #7650. |
| Session read, `POST /api/internal/auth/current-store/web-session/v1/session` | `webSessionReadCommandSchema`: `{ presented }`, the same `PresentedWebSession` login takes | 200 `active` with `userId`, `authSessionId`, `generation`, `expiresAt`, `source` (`login` or `bridge`), `authenticatedAt` (or null), `linkGuarded` and `user: { id, email, name, image }`, the fields of today's NextAuth session JSON (profile display name and avatar win); 401 `unauthenticated`; 503 `unavailable`. It applies exactly `readFirstPartySession`'s rules and writes nothing: no roll, no last-seen time, no bridge. A legacy cookie is answered by its own admission rules. |
| Sign-out, `POST /api/internal/auth/current-store/web-session/v1/signout` | `webSessionSignOutCommandSchema`: `{ presented, expectedUserId, expectedAuthSessionId }`, or the first form `{ token, … }` with a bare canonical token, still accepted so either web works with either backend | 200 `signed_out` (ended, or was not live); 409 `identity_changed` (the cookie carries another live session; nothing ended); 503 `unavailable`. A legacy cookie with its own session id gets a denial of that id and nothing else ends; one without a session id is answered `signed_out`, and only the row the bridge made from it, if any, ends. |
| Access token (B3a), `POST /api/internal/auth/current-store/web-session/v1/access` | `webSessionAccessCommandSchema`: `{ presented }` | 200 `active` with `userId`, `authSessionId`, `expiresAt` (after any roll), `rolled`, `accessToken` and `accessTokenExpiresAt`; 401 `unauthenticated` with `reason`: `no_session` (clear the cookie) or `bridge_required` (a legacy cookie: bridge it, then ask again); 503 `unavailable`, also when `AUTH_BROWSER_ACCESS_TOKEN_SECRET` is missing, weak or reused. The only place a web session rolls. |
| Bridge (B2a), `POST /api/internal/auth/current-store/web-session/v1/bridge` | `webSessionBridgeCommandSchema`: `{ credential }`, the joined NextAuth cookie (at most 12,288 characters) | 200 `bridged` with `userId`, `sessionId`, `token`, `expiresAt` and `generation`; 401 `denied` (see "Signed-in browsers from before the switch"); 503 `unavailable`, also when `NEXTAUTH_SECRET` or `AUTH_BRIDGE_TOKEN_SECRET` is missing, weak or reused. The same cookie always gets the same `token`. It does not read `AUTH_LEGACY_BRIDGE_MODE`, which the native refresh path keeps. |

A 401 means "no live session" only when its body parses as the command's own
reply (`outcome: 'unauthenticated'`, or `denied` from the bridge). The transport answers a wrong secret or a
browser `Origin` with 401 `{ "error": "unauthorized" }`, which no reply schema
accepts; www must treat that as unavailable and never clear a cookie on it.

A presented session that no longer reads as live is ignored, and a session
store that cannot be read fails the login with 503, so a login never succeeds
while leaving the presented session live. A presented legacy cookie without a
session id is ignored too: ending it would cut off the whole account, phones
included, so neither login nor sign-out ever performs an account cutoff. A
login presenting a legacy cookie answers 503 before any password work when the
backend has no `NEXTAUTH_SECRET`. A joined legacy cookie may be at most 12,288
characters (`LEGACY_WEB_SESSION_CREDENTIAL_MAX_LENGTH`), so the command stays
inside the 16,384-byte body budget. The legacy cookie's own sign-out
can also go to the existing `/api/internal/auth/current-store/signout` behind
`CURRENT_STORE_WEB_SIGNOUT_MODE`, whose no-SID path cuts off the account.

No reply of these commands sets a cookie. When a login asks for a session and
a credential proof together, the proof's `authSessionId` and `generation` are
the issued session's, so the legacy NextAuth cookie www writes from the proof
during the 30-day rollback window names the same session.

## www login, sign-out and session read (B1c)

Under `AUTH_BROWSER_SESSION_MODE=better-auth`, the `/api/auth/[...nextauth]`
route moves three answers to the first-party cookie
(`packages/web/app/lib/auth/browser-session-route.server.ts`). With the mode
unset, empty or `legacy` the route is the code it was, and
`packages/web/auth-proofs/legacy-route-snapshot.integration.proof.ts` pins its
status, body and `Set-Cookie` list for login, session read and sign-out.

The mode is read on the server for each request
(`browser-session-mode.server.ts`). `legacy` reads nothing else: no codec, no
secret. `better-auth` checks www's own preconditions once per configuration
(the private channel's origin and secret, the staged web auth mode, proof mode
`required`, `NEXTAUTH_SECRET` and `AUTH_BROWSER_SESSION_COOKIE_SECRET` of at
least 32 bytes, the cookie secret used for nothing else, a secure context
whenever `NODE_ENV=production`, and a cookie domain the codec accepts). With
one missing, or with any other mode value, every `/api/auth/*` route answers
503 and the log names one `AUTH_BROWSER_SESSION_WEB_*` code, never a value.
Even with every precondition met, `better-auth` stays `unavailable` while
`BROWSER_SESSION_WEB_CUTOVER_BLOCKERS` lists www work that has not landed (B4
to B7), as the backend's own list refuses to start; each later www PR deletes
its entry. Only tests build a resolver with another list
(`browserSessionRouteModeResolver`), which `better-auth-boundary.test.ts`
checks. `instrumentation.ts` runs the same check at boot and exits when the
mode would be `unavailable`, so a typo or a missing precondition keeps the
previous deployment serving instead of a healthy one answering 503. Unset,
empty and `legacy` boot as before.

Reading the cookies (`browser-session.server.ts`). The `Cookie` header goes to
the codec as received. A verified login cookie outranks a bridged one. A login
name sent as differing copies means signed out: neither the bridged nor the
legacy cookie stands in for it, though a login still presents the legacy
cookie of the same request so the session it names ends. With no first-party
cookie, the legacy NextAuth cookie (joined from its chunks) is presented. One
longer than `LEGACY_WEB_SESSION_CREDENTIAL_MAX_LENGTH` (12,288) is never sent:
the session read answers signed out, a login goes through presenting nothing,
and sign-out clears every session cookie without a backend call. The cookie name never decides
anything about the session; freshness and source come from the session row.

| Request | Under `better-auth` |
| --- | --- |
| `POST /api/auth/callback/credentials` | The staged password command with `webSession: { presented }` and the trusted `clientAddress`. A verified login must come back with the session and a credential proof naming the same session id and generation, so NextAuth's unchanged reply writes the legacy cookie for the rollback window on the same session. After NextAuth's own headers come the host-only legacy clear (as today), clears of the bridged name in both scopes, the host-only copy of the login name where the login cookie is written with a Domain (left out on host-only deployments, where it would delete the cookie just written), and the login cookie last. The login cookie name comes from how the session was obtained in this request, never from a session read's `source`. A wrong password or a login awaiting email verification changes no session cookie. A session issued without NextAuth writing its cookie, or the reverse, answers 503. |
| `POST /api/auth/signout` | The same form fields and the same 400, 409 and 503 answers as today. No session, or a conflicted login cookie, is 409. NextAuth's own handler still checks the CSRF token; a refusal goes back without revocation or clears. The backend `signout` command gets the first-party token when there is one, else the legacy cookie, with the expected viewer. `signed_out` clears both legacy names with every chunk (today's clears) and both first-party names in both scopes, plus the plain names the request carried. `identity_changed` is 409 and an outage is 503, and neither clears anything. NextAuth refuses a bad CSRF token by answering exactly `<NEXTAUTH_URL>/api/auth/signout?csrf=true`; only that answer counts as a refusal. |
| `GET` or `POST /api/auth/session` | With a first-party cookie, the backend `session` command answers in today's JSON shape: `user { name, email, image, id }`, `expires`, `authGeneration` and `authSessionId`, which the session guard keys on. No live session is `{}`, an outage is 503. A GET with only a legacy cookie bridges it (B2b, below); a POST answers it from the legacy path as before. Only the three planned cases of the bridge (below) write or clear a session cookie: NextAuth's rewrite of the legacy cookie is removed. |
| `GET /api/auth/csrf` | The legacy path with every session `Set-Cookie` removed. |
| Everything else | The legacy path. Google and Apple publish their own first-party session with its legacy twin (B5b). The native transfer provider is refused (B4c-web). |

A command reply counts only when its body parses as that command's reply, with
the status that reply is sent with. The transport's 401
`{ "error": "unauthorized" }`, a 404 `disabled` and any unparseable body are
unavailable (503), never signed out, so no cookie is cleared on a status
alone. `packages/web/auth-proofs/web-session-cookie.integration.proof.ts` and
`web-session-signout.integration.proof.ts` run the route against the real
backend handlers over HTTP and real PostgreSQL, with the www list replaced
through the test seam.

Two costs of keeping NextAuth from rewriting a legacy-only cookie under
`better-auth`: the profile claims it would have refreshed are never stored, so
after their five-minute TTL every session read and server render on such a
browser runs the `userProfiles` query; and the legacy cookie's expiry stops
sliding, so it ends 30 days after its last write. A rollback keeps such a
browser signed in only inside that window. A half-published login (the backend
issued a session but NextAuth wrote no cookie, or the new legacy cookie was not
admitted) answers 503 with the presented session already ended: the browser is
signed out and a retry works. This needs the backend's `verification.required`
and www's `EMAIL_VERIFICATION_ENABLED` set from the same value.

### Bridging on the session read (B2b)

`browser-session-bridge.server.ts`. A `GET /api/auth/session` bridges when the
request carries a legacy cookie and no first-party cookie of either name. A
first-party cookie that does not verify beside a valid legacy cookie is
bridged too, but nothing is written for it (B3b, see the ws-auth table). csrf,
a POST session read and every other route never bridge.
A legacy cookie sent twice under one name with differing values (a host-only
copy beside the Domain one), a base name beside chunk names, the plain and
`__Secure-` names with differing values, a conflicted bridged name with no
verified login cookie, and a legacy cookie over 12,288 characters all read as
signed out and bridge nothing. Only the legacy name this deployment writes is
bridged: a plain-named cookie in a secure context reads as signed out, as
NextAuth's own read does in production. Bridging is limited to 20 a minute per client address, keyed
as the sign-in limit keys (`trustedClientRateLimitKey`, #7760); over it, the
read answers from the legacy path.

The command is `/web-session/v1/bridge` with the joined cookie as received
(#7781). www acts only on a reply that parses:

- `bridged`: the answer is the backend's own read of the bridged session, in
  today's JSON shape, with the legacy cookie's session id as `authSessionId`.
  The bridged cookie is appended after every other session `Set-Cookie` was
  removed, with `Cache-Control: private, no-store`. This is the one planned
  exception to HARD RULE 2. The legacy cookie is kept: the rollback window
  needs it, and the next read sends the bridged cookie and writes nothing.
- `denied`: the read is signed out and the legacy cookie's names and chunks
  are cleared in both scopes. This includes the rollback cookie a login wrote
  under `better-auth` once its first-party cookie is gone: its session id is a
  `login` (or `carried`) row, which the bridge never re-keys. The cost: a
  browser that lost its first-party cookie but kept that legacy cookie signs in
  again.
- 503, a timeout, 400 or the transport's 401: the legacy path's answer as
  before, and no cookie changes. The bridged token is the same on every bridge
  of the same login, so a lost reply is recovered by the next read.

A stale first-party cookie after a rollback. While the mode is back on
`legacy`, a login writes only the legacy cookie and does not end the session of
a first-party cookie the browser still holds. When the mode is turned on again
the session read checks the legacy cookie beside a first-party cookie that
reads `active`:

- Beside a login cookie: when the legacy cookie carries another session id and
  its sign-in time (`auth_time`, else its issue time) is later than the
  session's `authenticatedAt`, the legacy login is the newer one. Every
  response that writes a login cookie also writes its legacy twin with the same
  session id, or clears the legacy names (`web-session-cookie.integration.proof.ts`
  pins this), so a legacy cookie with another id beside a login cookie was
  always written later; the time only confirms it.
- Beside a bridged cookie: when the legacy cookie carries a session id claim
  that differs from the bridged session's. There is no time test, because a
  bridged row's `authenticatedAt` is usually unknown and its id is the claim of
  the cookie it was bridged from. A cookie without the claim is never a newer
  login.

The read then bridges the legacy cookie: on `bridged` it clears a replaced
login cookie in both scopes (a replaced bridged cookie is overwritten) and sets
the bridged cookie; on `denied` the browser's last sign-in has ended, so it is
signed out and every session cookie name is cleared, never handed back to the
older session; on any other answer the first-party cookie answers this request
and the next read tries again. The same session id, an older legacy cookie,
or an unknown `authenticatedAt` beside a login cookie leave the first-party
cookie in charge. Only the legacy name this deployment writes counts.

What `legacy` mode itself does (owner decision, option a): when a login or
sign-out reply of the legacy route writes or clears the legacy session cookie
and the request carried a first-party cookie of either name, any value, the
reply also clears both first-party names in both scopes
(`withLegacyModeFirstPartyClears`). It needs no secret and no `better-auth`
precondition and never throws. No browser holds a first-party cookie before the
first cutover, so until then every reply is byte for byte the same; the legacy
snapshot proof pins both cases. Session reads and csrf never get these clears.

What this covers: a login or a sign-out made on www during a rollback. What it
does not: a browser that did neither during the rollback keeps its first-party
cookie, and that session's row decides what it reads after the roll-forward
(signed in if the row lives, signed out if a sign-out forwarded during the
rollback ended it). Google and Apple callbacks and the native transfer go
through the same legacy route, so they are covered too; anything that signs in
outside `/api/auth/*` is not.

Bridge and login race (`web-session-bridge.integration.proof.ts`). A delayed
bridge reply for A that lands after a login as B sets a bridged cookie for a
session B's login revoked; the login cookie outranks it, so B stays signed in.
If the login revoked A first, the late read is `denied` and clears the legacy
names, and B's login cookie still answers. That clear goes by name, not by
value, so it also deletes B's own rollback twin: B stays signed in on the login
cookie but has no legacy cookie for a rollback. www cannot tell such a reply
from a current one, so this is recorded rather than prevented.

The session read writes or clears a session cookie in three planned cases
only: the bridged cookie, the clears of a first-party cookie a newer legacy
login replaces, and the clears of a legacy cookie (and, when it was replacing
one, the first-party cookie) the backend denies. Nothing else.

### The bridge's end date and the generation-stamp gate (B2c)

The bridge ends at `AUTH_LEGACY_BRIDGE_UNTIL`, a time the owner sets to the
cutover plus 30 days (the legacy cookie's lifetime) and may move once. From
then on `/bridge` answers `denied` and writes nothing, so www reads a browser
holding only a legacy cookie as signed out and clears that cookie, as for any
other denied cookie. Unset, or not an exact time with an offset, `/bridge`
answers 503 in every mode, so no combination of switches runs an open-ended
bridge. Under `better-auth` the backend also refuses to start unless the time
is set and at most 45 days ahead. The one move is for a rollback: legacy
cookies a rollback rolled live 30 days from the roll-forward, so move the date
to the roll-forward plus 30 days.

Owner decision 4 split the activation gate `STAGED_WEB_PROOF_GENERATION_STAMP`.
Its code half is closed, each point with a named test (the table is under
"Code gates" in [the rollout doc](./better-auth-rollout.md)): the staged proof
carries the generation read where the credential was verified; under
`better-auth` www's `jwt` callback refuses a sign-in without a backend proof
before its own generation read, so nothing stamps 0 any more; a moved, zero or
missing stamp is denied by the bridge and by admission; a no-session-id cookie
is never bridged into an account cutoff. Its sign-out now writes a denial of
that cookie's own id even when nothing was bridged yet, so a bridge that
follows or races the sign-out is refused (a login presenting such a cookie
does the same). That ends the presented cookie's id and its own rotations, not
an independent older copy of the same login, which has another id: the same as
NextAuth's sign-out today, and the price of never cutting off the account. The
owner-only half remains as `HISTORICAL_WEB_ISSUER_RETIREMENT`: the owner
confirms on #7430 that the old Vercel deployments and rollback issuers are
retired, and a reviewed PR removes the entry. It blocks `activate`, the
identity mirror and the import. It is not a `better-auth` precondition (why
that is safe: "Code gates" in the rollout doc). The legacy sign-out writer,
`CURRENT_STORE_WEB_SIGNOUT_MODE=backend-staging`, keeps its own unconditional
startup refusal: its no-SID path still cuts off the whole account, which is
not approved.

## One guard in each browser client

Each browser surface gets one guard in its transport, keyed by who a request
was sent as. No call site is wrapped by hand. The guard works against NextAuth
today and keeps working after the switch, because both kinds of session expose
the same user id and auth session id.

### www (A2)

The guard keys on `(userId, authSessionId)`, both already on the client
session (`packages/web/app/lib/auth/types.ts:21-25`). `authSessionId` is
optional there, but the NextAuth `jwt` callback always sets one
(`auth-options.ts:476-479,493`); when it is missing, the guard uses the
placeholder `pending-login-identity`, as `session-provider.tsx:340` does. The
guard is the `fetch` option of the GraphQL HTTP client
(`app/lib/graphql/client.ts:25`, about 222 call sites in 76 files), and it
reads the whole body before deciding, because graphql-request reads the body
after `fetch` resolves. About 16 raw `fetch()` calls to user-scoped endpoints
switch to one exported guarded fetch. The shared WebSocket client
(`app/lib/realtime/graphql-client.ts`) is disposed and reconnected on a
generation change. The session provider, the one place that accepts a new
session read, reports every accepted identity to the guard.

| Change seen by a tab | Generation bumps (in-flight responses dropped) | Caches cleared | Reload |
| --- | --- | --- | --- |
| First read on page load | no | no | no |
| Same user, same `authSessionId` | no | no | no |
| Signed out to A | yes | no | no |
| A to A with a new `authSessionId` | yes | no | no |
| A to B, or A to signed out, started in this tab (sign-in, guarded sign-out) | yes | yes | no, the flow navigates itself |
| A to B, or A to signed out, started in another tab or the app | yes | yes | yes, to the locale root (`/`, `/es/`, ...) |

"Caches cleared" means the React Query cache, its persisted copy in IndexedDB
(`app/lib/react-query-idb-persister.ts`) and user-scoped IndexedDB.
`SessionCacheBuster` (`query-client-provider.tsx:98-128`) does most of this
today, keyed by user id only; A2 drives it from the guard. The provider
accepts only a 2xx with a valid body and keeps the current session on any
failure (`session-provider.tsx:187-191,244-249`), so an outage never changes
identity, reloads or clears anything (#6979 criterion 4).

### Expo web on app.boardsesh.com (A3)

The guard drops a response when the confirmed `(userId, authSessionId)` or the
credential generation changed since the request was sent. The generation is
`sessionGeneration` (`packages/mobile/src/lib/auth-store.web.ts:67`). Every
authenticated HTTP request already passes through `authenticatedFetch`, but it
returns the response even when the generation changed during the request
(`auth-interceptor.web.ts:218-222`); today only the call sites the earlier
BA-05 PRs wrapped are protected. A3 adds the check there, plus a page latch.

The first identity a page confirms is that page's identity. The latch compares
the confirmed `(userId, authSessionId)` only, and a later change to a different
pair, including signed out, retires the page. A retired page refuses new
sends, drops every response and body read, disposes its WebSocket, runs the
existing old-owner cleanup in `auth-provider.tsx` (which clears the
`user:<id>:auth-session:<sid>` IndexedDB keys,
`user-storage-owner.web.ts:97-98`), then calls `location.replace` with the app
root. A login on a signed-out page sets the latch without retiring it.

A generation-only bump drops in-flight responses but never retires the page or
runs cleanup. Such bumps follow every peer `credential-rotation` broadcast
(`auth-store.web.ts:165-167`), including the hint a tab sends when its
sign-out fails during an outage (`auth.web.ts:486`), so other tabs keep their
session through that outage (#6979 criterion 4).

Native iOS and Android must not change. Any file without a `.web` suffix under
`packages/mobile` or `packages/shared` ships to phones by OTA on every push to
main, so A3 works in `.web` files and inside existing `Platform.OS === 'web'`
branches. Where a shared file must change, a test shows the native path is
unchanged. Toasts are that case: Expo web toasts go through the shared
`providers/toast-provider.tsx`, whose only platform branches are for iOS
(`:75,122`). A3 gates it through a fork pair whose native side returns a
constant, and `web-fork-export-parity.test.ts` checks the pair. Expo web has
no central router seam, so navigation gating is open question 8. A3's tests
run the same flows as `ios` and `android` and expect today's behaviour.

### The viewer marker: learning of a switch on another host

A reply that lands in a tab on www after the browser signed in as another
account on the other host (app.boardsesh.com, or the reverse) is a plain 200:
no 401, no 409 and no same-origin message reaches the tab. To catch it when
the reply lands, without one more request on the normal path, the server
writes a readable marker beside the session cookie (decision of 2026-11-18 on
#7596, "how the guard learns of an account switch on another host").

| | |
| --- | --- |
| Name | `__Secure-boardsesh.viewer`; `boardsesh.viewer` on local http |
| Value | the first 16 characters of `base64url(sha256("boardsesh-viewer-v1:" + authSessionId))` |
| Attributes | the session cookie's `Path=/`, `Domain` (exactly when the session cookie in the same response has it), `Max-Age=34560000`, `SameSite=Lax`, `Secure`; **not** HttpOnly |
| Written | last, by password login, Google and Apple publish, and the one bridging session read, for the session id they issue. A login and, on a Domain deployment, the bridging read first clear a host-only copy |
| Cleared | in both scopes, by sign-out, the session read's first-party clears, and legacy mode's first-party clears (only when the request carried a first-party cookie) |
| Code | `@boardsesh/auth-protocol/viewer-marker` (name, WebCrypto digest, `document.cookie` reader); the server value and the cookie in `browser-session-cookie.ts`; Expo web keeps a `.web` copy (`viewer-marker.web.ts`) held to the same value vector, so the app package takes no new dependency |

`withoutSessionSetCookies` strips it like a session cookie, so session reads,
csrf, ws-auth, set-password and provider link never carry it. The server never
reads it (`viewer-marker-server-reads.test.ts`), and it is not the token: it
cannot be turned back into the session id. In `legacy` mode, or with the mode
unset, no marker is ever written.

Each guard computes the marker it expects from its accepted login and reads
`document.cookie` when a reply lands (www: `guardedFetch`, and `runIfCurrent`
for toasts and navigation; Expo web: `admitSessionResponse`).

**Armed only by a marker the server wrote** (review of #7810, round 2, M2). A
document checks nothing until it has seen its own login's marker once: when
the login is accepted and the digest is in, or on a later reply. Only a server
under `better-auth` writes one, so with the mode unset or `legacy` a planted
marker of any value is ignored: no probe, no hold, no lost toast. Then:

- **Match:** deliver.
- **Not armed:** deliver, whatever the cookie holds.
- **Armed, missing:** a mismatch (a sign-out on the other host).
- **Armed, two differing copies** (a copy at another `Path` or in another
  scope, which the clears at `Path=/` never reach): one false value, checked
  once like any other.
- **Armed, another value:** hold the reply and run the existing session check
  (www: the ws-auth probe, then a session read if it differs; Expo web: the
  shared `synchronizeWebSession`). Another account: the reply is superseded
  and the page clears its caches and reloads from the root. The same login
  confirmed: the reply is delivered, the value is remembered, and on www
  everything that waited for the check runs (`runIfCurrent`: a toast or a
  navigation asked for during the hold is shown, not dropped) and
  subscribers are told. Nothing proven (an outage): the reply is superseded;
  later replies under that value are delivered as before the marker, and
  the value is checked again on a reply after 30 s, then 60 s, doubling to 5
  minutes, within the four checks per document.
- An anonymous tab, or a login with no `authSessionId` yet, checks nothing.

Bounds against cookie tossing from a sibling host: one check per false value
(and per retry of one that proved nothing), at most four per document; a
fifth turns the check off for that document. A copy of the marker at another
`Path` survives every clear and reads as conflicted; in an armed document that
is one more false value, so a sibling host gains nothing it could not get with
a fifth value. The marker alone never signs out or reloads; only a session read
that names another account retires a page. Making the marker match A hides a
switch, which is the behaviour without the marker. On previews and locally
the marker is host-only on www, so the app host never sees it and stays on
focus, `pageshow`, 401 and the BroadcastChannel. A rollback leaves a stale
marker, which costs at most one extra check per page load. Accepted: any
script on a `boardsesh.com` host can read a stable per-login label for up to
400 days; it is a truncated hash the server ignores, and analytics send no
cookies.

### Re-reading the session

Both clients re-read the session on `pageshow` from the back/forward cache, on
`focus` and `visibilitychange` at most once every 30 seconds, and on a 401
(parallel 401s cause one read). Today www lacks the focus and 401 re-reads,
and Expo web lacks `pageshow` and focus. In Phase A every NextAuth session GET
rewrites the cookie, which is the race in
[the cookie-order doc](better-auth-browser-cookie-order.md), so the extra
re-reads should use a probe that sets no cookie. The candidate is
`/api/internal/ws-auth`, which reads the cookie with `getToken` and answers
JSON (`ws-auth/route.ts:18-89`). A2 confirms in the installed NextAuth that
this path never sets a cookie; if it does, the re-read falls back to a session
GET at the same 30-second throttle.

### Superseded responses

A response the guard drops reaches the caller as a `SessionSupersededError`,
and the caller shows nothing: no toast, no navigation, no cache write. On www,
toasts and navigation each pass one generation check, so a late error handler
from the old account shows nothing under the new one. On Expo web, toasts pass
the fork-pair check above.

The guard reuses what exists. On www: `SessionCacheBuster`, the guarded
sign-out (`nextauth-cookie-fetch-lock.ts:293`) and the same-origin cookie fetch
lock (`nextauth-cookie-fetch-lock.ts:255`), which stays until Phase B. On Expo
web: `sessionGeneration`, the `boardsesh-expo-web-auth-v1` BroadcastChannel
(`auth-store.web.ts:77,157`) and the storage owner key.

### Expected viewer on cookie routes (owner decision 4)

Some `/api/internal/*` routes on www know the caller only from the shared
cookie. A tab that has not yet noticed a switch made on app.boardsesh.com can
send one of them, and the cookie answers as the new account. Without a check,
the old page shows that account's data or writes as it until the next re-read
reloads it: up to 45 seconds after the climber comes back to the tab (the
30-second focus throttle plus the 15-second probe deadline in
`session-provider.tsx`).

The www guard names the account its page shows on every request to its own
origin, in `X-Boardsesh-Expected-Viewer`:

- signed in: `<userId>:<authSessionId>`, the guard's own `sessionViewerKey`
  of the accepted session (with `pending-login-identity` when the session has
  no `authSessionId`);
- signed out: `anonymous`, so a signed-out page cannot receive a signed-in
  account's data either;
- before the first session read is accepted: no header. The page shows no
  account yet.

Requests to another origin (the GraphQL backend, uploads, Aurora) never carry
it, so no request gains a CORS preflight.

`requireExpectedViewer` (`app/lib/auth/expected-viewer.server.ts`) runs right
after the route reads the session and before any other read or write. It
compares the header with the session the cookie resolved to, in the same key
format. On a mismatch (another account, another login of the same account, a
signed-out page against a signed-in cookie, the reverse, or an unreadable
value) it answers 409 with
`{ "code": "viewer_changed", "error": "Reload this page." }` and
`Cache-Control: private, no-store`. The body names no account; `error` is what
a tab loaded before this change shows as its failure toast. Each refusal writes
one `warn` line, `expected viewer refused`, with the route template, the method
and a reason (`header_missing`, `other_user`, `other_session`,
`anonymous_cookie` or `malformed`), and no user id, session id, header value or
resolved path. It is a log line, not a Sentry event: searchable in the Railway
logs, and it pages nobody. A run of `malformed` or `other_session` with no
account switch behind it means the browser and the server build the key
differently.

The guard turns that answer into `SessionSupersededError` and asks for the
session check at once, skipping the 30-second focus throttle. If a probe is
already out, one more runs after it, because that probe may have read the
cookie before it changed. The check then retires the page as in the table
above. Other 409s, such as "Password already set.", reach the caller as before.

The settings page sends its requests through `guardedActionFetch`, which waits
for that check and then acts on what it found. Only a probe or session read
that started after the 409, or a read that moved the viewer, ends the wait; a
read already in flight may have seen the cookie before it changed. The
provider records when each probe and read starts (`sessionReadStarted`) and
passes it back. The wait is 30 seconds at most.

- the page is moving to another account: nothing is shown, the page reloads;
- a read or a delete: sent once more, with the header the check left (a new
  login of the same account keeps the page and changes only the session id).
  Refused again, the card shows "This page is out of date" with a Reload
  button;
- a write (register a controller, set a password) is never sent twice, because
  a lost answer may have committed. Refused once, the form stays open with
  what was typed and says "That didn't go through. Try again." Refused twice
  in a row, or answered after the page's login changed (a controller may exist
  whose one-time key is gone), the form shows the reload message, still open,
  and the controllers list is read again. The count of refusals starts again
  when any action is answered or the viewer moves, so two refusals hours apart
  never add up.

The messages are inline rather than toasts, because the snackbar drops a toast
from before an account change, and after a new login of the same account they
must still show. Their text is `settings.reloadRequired` and
`settings.writeRefused` in all five locales; the reload message says only that
the page is out of date, because the cause is not always an account change.

All three ends build the key the same way for both cookie shapes that exist at
deploy: a login with an `authSessionId` claim, and a login from before the
claim, whose id the jwt callback takes from the cookie's `jti` on every read.
`ws-auth` (the focus probe and the WebSocket token) used to answer no id for
the second shape, so the probe saw `pending-login-identity`, the page saw the
`jti`, and every probe asked for a session read until that read had rewritten
the cookie; it now answers the `jti` too. `expected-viewer-sign-in.test.ts`
checks the guard, the probe and the routes for a current login, a pre-claim
login, and a pre-claim login whose rewritten cookie was lost.

| Route | Missing header | Why |
| --- | --- | --- |
| `controllers` GET, POST, DELETE | 409 when the cookie is signed in | Its only caller is the `/settings` controllers card, through the guard. |
| `set-password` POST | 409 when the cookie is signed in | Its only caller is the `/settings` password card, through the guard. In `legacy` mode nothing else compares the body's `expectedUserId` with the cookie. |
| `profile` GET | Served as before | The published OpenAPI document lists it for any session holder. |
| `profile/[userId]` GET | Served as before | The OpenAPI document lists it for anonymous callers; what it returns depends on the viewer. |

A request with neither the header nor a signed-in cookie goes on under both
policies and gets the route's usual signed-out answer. The other
`/api/internal/*` routes need no check: `ws-auth` echoes the viewer and the
client compares; `climb-search-cache/revalidate` takes a cookie but only clears
a board's public cache tag, the same for any account; `feature-flags` is an
admin page opened by hand, never fetched by a page; `join/[sessionId]` is a
top-level link that redirects, so the next page renders the current account;
`cleanup`, `profile-percentiles`, `refresh-sitemap-climbs` and
`revalidate-climb` take a bearer secret, not a cookie; `dev-metadata` answers
only in development and holds no account data; `beta-link-thumbnail` is an
unauthenticated image proxy. Expo web calls none of the four checked routes
(none is in `cross-subdomain-cors.ts`), so neither its transport nor CORS
changed.

What stays open:

1. A tab loaded before this shipped sends no header. Until it reloads, its
   controllers card lists no controllers (the old code shows the empty state
   for any failed read), and registering, removing or setting a password shows
   the toast "Reload this page." Its profile reads are served as before.
2. Soft navigation. The App Router fetches server components with the cookie,
   not through `guardedFetch`, and the guard cannot add a header to those
   requests. A stale tab that follows a link to `/profile/<id>` gets that page
   rendered for the new account (`profile/[user_id]/page.tsx` reads the
   session and calls `getProfileData`, the same data as
   `/api/internal/profile/[userId]`); other private server pages (playlists,
   gym management, build-plan orders) behave the same. The four API routes are
   not reachable that way. The next re-read still retires the page.
3. No browser test drives two real origins. `expected-viewer-sign-in.test.ts`
   runs the real NextAuth `jwt` and `session` callbacks, NextAuth's session
   handler, `getAdmittedServerSession`, the guard and the four routes, and
   expects no 409 (the browser and server keys agree);
   `viewer-switch-race.test.ts` runs the real guard against the real
   controllers route with the cookie switched underneath; and
   `session-provider-guard.test.tsx` runs the provider's re-check, retry and
   reload.

## How each race is handled

| Race | What happens | Where |
| --- | --- | --- |
| A mutation started as A lands after a switch to B | The server commits it to A, which is correct. The caller gets `SessionSupersededError` and shows nothing. | A2, A3 |
| A query response for A arrives after the switch | Dropped after the full body is read (www), or on delivery and on every body read (Expo web). | A2, A3 |
| Cached queries and optimistic updates | Query cache, persisted cache and user-scoped IndexedDB are cleared on a user change. A change made elsewhere also reloads. | A2, A3 |
| WebSockets | The client is disposed on a generation change and reconnects. The server cutoff sweep closes revoked sockets every 1,000 ms ([enforcement windows](better-auth-enforcement-windows.md)). | A2, A3 |
| Offline outbox | Expo web has none. Native is out of scope and does not change. | none |
| Back/forward cache | `pageshow` with `persisted` re-reads the session. A changed identity reloads. | A2, A3 |
| Next Router Cache (soft back and forward) | No `pageshow` fires. The reload on a change made elsewhere, or the full navigation of this tab's own sign-in or sign-out, drops the cache. | A2 |
| Login on www while an app tab is open | Phase A: the app tab notices on focus, visibility or `pageshow`, because BroadcastChannel and `storage` events do not cross origins. Phase B: the login revokes A's session, so A's next request gets a 401 and the tab reloads as B. | A3, B1 |
| Login on app.boardsesh.com while a www tab is open, which then calls a cookie-only `/api/internal/*` route | The route answers 409 `viewer_changed` before it reads or writes; the guard re-checks at once and the tab reloads as B. A soft navigation to a private server page is not covered (see "Expected viewer on cookie routes"). | Decision 4 |
| A reply of A's, already answered, lands after B signed in on the other host | The viewer marker no longer names A's login, so the guard holds the reply and runs the session check; it names B, the reply is superseded and the tab reloads from the root as B, with no focus. | Viewer marker |
| A delayed session read or set-password response overwrites a later login's cookie | Remains in Phase A, because NextAuth writes on every read. In Phase B only the read that bridges a legacy cookie still writes, so the race stays for that read (open question 3). | B1, B2, B4 |
| Two logins in two tabs at nearly the same moment | Accepted, see below. | none |
| Backend or auth outage | No identity change, so no reload and no cleanup. | A2, A3 |

## What this design accepts

These are the three items #7596 lists:

1. Two logins in two tabs at nearly the same moment. If A's login response
   arrives after B's, the browser ends up signed in as A and B has to sign in
   again. No data crosses accounts.
2. A reload on account switch. In-flight work in other tabs does not survive
   it. On app.boardsesh.com, signing out also reloads.
3. The cookie scope stays as it is today, including the preview hosts.

## The switch

`AUTH_BROWSER_SESSION_MODE` takes two values: `legacy`, the default when unset
or empty, and `better-auth`. Any other value is refused, including a different
case or surrounding spaces. The parser is `parseBrowserSessionMode` in
`@boardsesh/auth-protocol/browser-session-mode`, shaped like
`partner-oauth-mode.ts`, except that an unknown value throws instead of
reading as off, and the error never repeats the value.

What the code does in Phase A:

- **Backend.** `assertBrowserSessionModeConfiguration`
  (`packages/backend/src/auth/authority/browser-session-mode.ts`) runs at
  startup, in `main()` and in `startServer()`, next to the other authority
  startup checks and before anything listens. An unknown value refuses to
  start. `better-auth` refuses to start too, with an error that says B1
  (#7596) has not landed, because nothing serves a Better Auth browser
  session yet. B1 replaces that refusal with its startup preconditions.
- **www.** Since B1c, `browserSessionRouteMode()` reads it on the server for
  each `/api/auth/*` request (see "www login, sign-out and session read").
  Server renders and private routes follow in B4, which passes resolved values
  to client components as props, as `app/layout.tsx` already does with
  `enableExpoAuthBridge`. It is never `NEXT_PUBLIC_*`, which is baked in at
  build time, so a rollback would need a rebuild.
- **Expo web.** No flag.

It replaces the eight code-owned gates, each a literal `return false`: seven
`packages/web/app/lib/auth/*-readiness.ts` files and
`packages/mobile/src/lib/browser-consumer-readiness.web.ts`
(`scripts/lib/expo-web-readiness.ts` is the dev server's Metro prewarm helper,
not a gate). A5 deleted each one with the code it guarded; the last,
`browser-consumer-readiness.ts`, went with the binding web core. None is left
in `packages/web` or `packages/backend`. The Expo web gate went with the
selected mode it guarded: the lease client, the iframe coordinator client and
the selected WebSocket client.

Once B4 gives www its reader, turn it on in the backend first, then web. Roll
back web first, then backend.
A browser signed in before cutover keeps its legacy cookie and stays signed in
after a rollback. A browser that logged in after cutover has no valid legacy
cookie, because the login revoked the legacy session it presented, so a
rollback signs it out unless login also writes a legacy JWE during the 30 days
(open question 4). The owner sets the variable from paste-ready steps in
#7430. It stays `legacy` in production until every acceptance item has a
passing test in CI.

Proposed startup preconditions for `better-auth`, for B1 to settle: cutoff
enforcement on, `AUTH_LEGACY_BRIDGE_MODE=on`, the web sign-out mode at
`backend-staging` (the bridge requires it, `web-credential-proof.ts:54-58`),
and the BA-04 authority switch done.

## Provider and first-password flows

The backend cores stay. Google and Apple link and unlink require real
reauthentication within five minutes (owner decision, 2026-11-13); for Google
only a signed `auth_time` in a verified ID token counts
([provider security adoption](./better-auth-provider-security-adoption.md)).
Accounts with no password and a Google or Apple identity set a first
password after email confirmation (Apple-only at first; widened by the
decision of 2026-11-18 on #7596), which is not provider reauthentication. Facebook sign-in and linking stay removed;
stored Facebook identities stay. Drizzle schema exports and merged migrations
stay, and this work writes no migrations.

Since B5c1, provider link, unlink, reauthentication and the ownership check
take the first-party web session (`presented`: the canonical token or the
legacy cookie, plus the user and session id the tab expects), read by
`readFirstPartySession`, never a browser binding. Every step presents the same
session token; the intent stores its hash and refuses any other. The intent's
NOT NULL binding columns hold values keyed by the session:
`browser_binding_hash` is the SHA-256 of
`["provider-security-web-session-v1", sessionId]`, `browser_version` is 0,
`browser_intent_hash` is derived from the intent itself, and
`browser_binding_expires_at` is the session's expiry when the intent was made.
Finalize keeps the session's id, token, sign-in time and expiry and moves only
its generation to the account's new one (`keepCanonicalAfterSecurityMutation`);
every other web session, native refresh token, partner connection and pending
recovery or verification link of the account ends. No candidate credential and
no cookie write exist any more. A legacy NextAuth cookie can read its methods
but cannot start a link or unlink: its generation lives in the cookie, so it
could continue only by being re-issued, which only a login may do. The backend
answers `canonical_session_required` (403), apart from
`reauthentication_required`, so www knows to bridge it first (B2b) rather than
ask for a password. The backend refuses to start with
`CURRENT_STORE_PROVIDER_SECURITY_MODE=backend-staging` unless
`AUTH_BROWSER_SESSION_MODE=better-auth`
(`AUTH_PROVIDER_SECURITY_BROWSER_SESSION_REQUIRED`): without it nobody could
link.

Rollback after a link or unlink (accepted). During the 30-day rollback window
a login also writes the legacy NextAuth cookie with the same session id
(owner decision 2 of 2026-11-17). A link or unlink moves the account to a new
generation and keeps only the canonical cookie's session alive, because only a
login may write a cookie. The legacy cookie still names the old generation, so
it is dead from that moment. If the mode is rolled back to `legacy` inside the
window, that browser has to sign in again. This is the one exception to
acceptance 6 ("rollback leaves every browser signed in"); it applies only to a
browser that linked or unlinked a provider after cutover, and the alternative
is a cookie write outside login, which this design does not allow. The same
holds for first password, which keeps its token since B5c2. The backend
refuses to start with `CURRENT_STORE_FIRST_PASSWORD_MODE=backend-staging`
unless `AUTH_BROWSER_SESSION_MODE=better-auth`
(`AUTH_FIRST_PASSWORD_BROWSER_SESSION_REQUIRED`). What the binding proved, the same browser across the OAuth
round trip, now comes from the session token every step presents plus the
OAuth state hash bound to the intent (`bind`) and checked at `prepare`.

Since B5c2, first password (`first-password-*.ts`) is keyed the same way:
the same admission, the same refusal for a legacy cookie, the same columns
(`auth_first_password_challenges`), and finalize keeps the session's token
through the `password-set` receipt. The emailed confirmation link must be
completed by the session token that asked for it. Nothing deletes intents or
challenges (the credential role has no DELETE), so both are bounded at
creation: one session holds at most five unexpired pending or prepared provider
intents (`PROVIDER_SECURITY_LIVE_INTENTS_PER_SESSION`, refusal
`too_many_pending`), and an account holds one live first-password challenge (a
new request ends the old one; `auth_first_password_active_user_idx`).

Google and Apple sign-in (B5a). The web OAuth `resolve` command takes an
optional `webSession: { presented?, googleAuthentication? }`. With it (and
`CURRENT_STORE_WEB_SESSION_MODE=backend-staging`, else 404), `resolve` issues a
first-party web session for the resolved account with `issueWebSession`, in
the transaction that resolved the identity, revoking `presented`; the reply
adds `webSession: { sessionId, token, expiresAt, generation }`, and the
credential proof names the same session id and generation. `users` rows are
locked in one pass through `lockWebSessionAccounts` (the provider's owner FOR
UPDATE, since resolution writes its rows, and the presented account FOR
UPDATE), after the provider-subject lock, so crossed sign-ins queue. A session
request needs `actorCookie: null`: a sign-in never links a provider to the
account it arrived as. An unknown provider creates a new account as a
signed-out sign-in does, unless a live session is presented: then it is
`link_required` (decision D1, B5e1, below). Freshness: Google is a `login` only when the backend
verifies a signed `auth_time` under five minutes old for this subject
(`CURRENT_STORE_PROVIDER_GOOGLE_AUTH_TIME_MODE=auth-time-staging`), with the
nonce bound into the intent's `flow` (`flow` = SHA-256 hex of
`JSON.stringify(["web-oauth-google-nonce-v1", nonce])`); otherwise, and always
for Apple, the session is `carried`: it keeps this sign-in's time for the
30-day rules but never passes a five-minute check. The proof tells www the
same thing: `authenticatedAt: null, linkGuarded: false` for a carried session,
so the legacy rollback cookie carries no `auth_time`; the verified `auth_time`
and `linkGuarded: true` for a fresh one. Without `webSession` the command and
reply are unchanged. The browser-binding `signin-*` commands and the
anonymous-provider protocol are deleted.

B5d deleted the binding core: `authority/browser-binding.ts`, its tests and
restricted-role proof, the `browser-binding-v1` protocol, and
`CURRENT_STORE_BROWSER_BINDING_MODE`. No migration and no DROP: the
`auth_browser_bindings` and `auth_browser_intents` tables, their grants and
their Drizzle exports stay, unread. The NOT NULL `browser_*` columns of
`auth_provider_security_intents` and `auth_first_password_challenges` stay
too and keep their derived values (`browser_binding_hash` = the prefixed
session hash, `browser_version` 0, `browser_intent_hash` derived from the row,
`browser_binding_expires_at` = the session's expiry at creation), and so do
`proposed_credential_hash` and `candidate_credential_hash` (the presented
token's hash). They remain because dropping them needs a generated migration
plus new pinned credential-writer catalogs, for no behaviour gain, and because
`browser_binding_hash` is what tells a row written under the session keying
from one written under the binding (the readers refuse the latter). Dropping
them is a separate decision, after counting zero binding-era rows in both
tables. Log redaction for the old `__Host-boardsesh.*` cookie families stays
(`text-redaction/src/password-recovery.ts`): browsers may still send one.

The web publication layer for these flows is deleted in A5 and rebuilt on the
new session in B5: the provider Settings UI and its server code, the
first-password web layer, the web half of Google reauthentication, anonymous
and owned provider sign-in, the ACK step and the provider-security web core
(command client, candidate issuer, sealed flow cookie, actor selection and the
`publicProviderSecurityReady()` gate). It imported the binding, both directly
and through the shared actor selection. With every gate `false` it
showed nothing in production, so deleting it changes nothing live except the
Cookie-header check under "What is removed". The dark
`/auth/browser-coordinator` and `/auth/confirm-first-password` pages may become
404s. The provider-security, Google auth-time and first-password
`CURRENT_STORE_*` selectors stay backend-only;
`CURRENT_STORE_PROVIDER_SECURITY_MODE=backend-staging` already changes legacy
behaviour (`current-store/set-password.ts:43`,
`current-store/web-oauth-identity.ts:181`).


### Google and Apple sign-in on www (B5b)

Under `AUTH_BROWSER_SESSION_MODE=better-auth`, www needs
`CURRENT_STORE_WEB_OAUTH_MODE=backend-staging` (precondition
`AUTH_BROWSER_SESSION_WEB_OAUTH_MODE_REQUIRED`), and every Google or Apple
start through `/api/auth/signin/*` is an explicit sign-in
(`web-oauth-session.server.ts`, `web-oauth-request.server.ts`):

- `intent` and `resolve` carry `actorCookie: null`: a sign-in never links into
  the account the browser arrived as. Linking is provider security's (B5c1,
  B5e). NextAuth's own "signed in" read of its cookie is switched off for the
  callback, so it never tries to link either.
- `resolve` sends `webSession: { presented }`, the cookie the callback arrived
  with (the verified first-party cookie first, else the legacy cookie, never
  both; a legacy cookie no command accepts is dropped), and always
  `credentialProofVersion`.
- A reply counts only with the session and a credential proof naming the same
  session id and generation; otherwise www answers its outage page and no
  session cookie changes. A lost reply, a 503 and the backend's 404 (its
  web-session mode off) do the same; the intent is consumed, so the climber
  starts the sign-in again. `email_conflict` and `email_required` keep today's
  pages and change no cookie.
- One response publishes the sign-in: NextAuth's legacy twin with the proof's
  session id (checked again when the twin is encoded: another id publishes
  nothing) (no `auth_time` and no `link_guarded` for a `carried` login), the
  host-only legacy clear, clears of every other legacy name or chunk the
  request carried (and of the host-only copy of each chunk the twin rewrites), clears of the bridged name in both scopes, then the login
  cookie. So no legacy cookie with another id stays beside the new login cookie,
  which rule (c) would otherwise follow: a fresh Google login's
  `authenticatedAt` is Google's `auth_time`, up to five minutes before the
  login, and a leftover legacy cookie written in that gap would look newer.
- Google freshness (#7655, #7590). NextAuth's `nonce` check is on for these
  flows: a 32-byte random nonce goes to Google and into a sealed HttpOnly
  cookie of the flow, `__Host-next-auth.nonce.<scope>` in a secure context
  (host-only, Secure, `Path=/`, so a sibling subdomain cannot plant a copy;
  the plain name on local http), and the ID token must carry it. A withheld
  reply (503, 404, lost) and a retired flow clear it with the name and options
  it was written with. The intent's
  `flow` is the SHA-256 hex of `JSON.stringify(["web-oauth-google-nonce-v1",
  nonce])`, and `resolve` forwards the raw ID token and the nonce. Every sign-in
  asks Google for `max_age=31536000`, so the token carries `auth_time` without
  making a climber already signed in to Google sign in again. The backend counts
  the session as a fresh login only when Google's own `auth_time` is under five
  minutes old; a silent sign-in is `carried` and never passes a five-minute
  check. A forced reauthentication (`max_age=0`) is B5e1's re-sign-in page
  (`/auth/reauthenticate`, below). Apple sign-ins are always `carried`.
- The B1c rule that cleared the first-party names on a legacy provider login
  is gone: Google and Apple publish their own session, and the native transfer
  provider is refused under `better-auth` (B4c-web).
- The NextAuth link guard (`oauth-link-guard.server.ts`) runs only on the
  legacy web OAuth path, which under `better-auth` answers 503 instead.

`web-provider-session.integration.proof.ts` drives Google end to end through
the real route against a loopback stand-in that signs real ID tokens, the real
backend web OAuth and web-session handlers and real PostgreSQL. A Google ID
token without `auth_time` (Google ignoring `max_age`) signs in as `carried`
(proven). `web-apple-sign-in.integration.proof.ts` does the same for Apple
against an Apple stand-in (`auth-proofs/apple-oidc-fixture.ts`: it names
itself `https://appleid.apple.com`, answers with `response_mode=form_post`
and signs RS256 ID tokens, as Apple does; the ES256 JWT is Apple's client
secret, which the stand-in only compares): the form arrives with only the
SameSite=None flow cookies, is held (303 to the resume GET, a Lax
continuation cookie, no session cookie), and the resumed GET presents the
session the browser held, ends it and publishes a `carried` login with its
twin (no `auth_time`, no `link_guarded`) and the marker; an Expo web return
lands on the app with the session published on the same reply. In a real
browser, `provider-sign-in.spec.ts` signs in with both through www's own
buttons (B7c, below). `B5B_WWW_PROVIDER_SIGN_IN` and the backend's
`B5_PROVIDER_SIGN_IN` left the cutover lists with these. Runbook note: a Google flow started in one mode and finished in the
other answers the outage page; it lasts 15 minutes at most, and starting again
works.

**Signed in, an unknown provider identity is `link_required` (decision D1,
B5e1).** When `resolve` with `webSession` presents a live session (canonical,
bridged or legacy, admitted by the reader) and no account owns the verified
provider subject, the backend answers the denial code `link_required` (409):
no account and no provider row are created, the presented session is kept,
and the intent is consumed like any other end. A known subject still signs in
and ends the presented session; with no live presented session an unknown
subject still creates an account. www sends the browser to
`/auth/error?error=OAuthLinkRequired` ("You're signed in as X. To sign in with
this Google or Apple account, connect it from Settings first.") and changes no
cookie. It is checked before the email rule, so a signed-in climber who brings
an unknown identity with another account's address also gets `link_required`;
signed out, that is still `email_conflict`.

### Link, unlink and reauthentication on www (B5e1)

Under `AUTH_BROWSER_SESSION_MODE=better-auth`, www serves
`/api/auth/provider-security/*` (`provider-security-route.server.ts`, Node
runtime) on the backend's `provider-security-v1` commands. With the mode unset,
empty or `legacy` every one of these routes answers 404. Under `better-auth`
they answer 503 unless www's own `CURRENT_STORE_PROVIDER_SECURITY_MODE` is
`backend-staging`.

| Route | Method | What it does | Answers |
|---|---|---|---|
| `methods` | GET | The signed-in account's methods: password usable, linked Google/Apple identities (`methodId`, `canUnlink`), configured providers, which reauthentication methods work (`password`, `google`; `apple` is always false), and `linking` per provider (`{ available }`, or `{ available: false, reason: 'not_configured' }`) | 200 `{ status: 'methods', … }` |
| `start` | POST `{ action, provider, methodId?, returnTo? }` | Creates the backend intent with the canonical session as actor (never the legacy cookie, never with `webSession`), and writes the sealed flow cookie (SameSite=None for an Apple link) | 200 `{ status: 'reauthentication_required', action, provider, expiresAt }` |
| `reauthenticate/password` | POST `{ password }` | `reauthenticate-password`; then an unlink prepares and finalizes, and a link binds its provider round trip | 200 `committed` (unlink) or `{ status: 'redirect', url }` (link) |
| `reauthenticate/google` | POST | `bind-google-reauthentication` and Google's URL with `max_age=0` and `prompt=select_account consent` (#7590) | 200 `{ status: 'redirect', url }` |
| `reauthenticate/apple` | POST | Always refused: the backend verifies no Apple ID token, so Apple cannot prove a fresh sign-in (#7655 item 3). Apple-only accounts reauthenticate by setting a first password (B5e2) | 403 `reauthentication_unavailable` |
| `callback/google` | GET | Finishes a Google reauthentication (`reauthenticate-google` with the raw ID token, nonce and the hash of the query `state`) or a Google link (`prepare` with the verified identity and the hash of the query `state`, then `finalize`) | 303 to `returnTo?providerSecurity=…` |
| `callback/apple` | POST, then GET `?resume=1` | Apple's cross-site `form_post` is held in the flow cookie after its state matches; the same-site GET (which carries the Lax session cookie) finishes the link | 303 as above |
| `abort` | POST | Ends the open intent and the flow cookie | 200 `{ status: 'aborted' }` |
| `recover` | POST | Asks `recover` about a link or unlink whose reply was lost | 200 `committed` or a refusal |

A callback's `providerSecurity` is `linked`, `unlinked`, `cancelled`,
`unavailable`, `expired`, `state_mismatch`, `session_required`,
`identity_changed`, `provider_not_verified` or the backend's refusal code
(`reauthentication_required`, `last_usable_method`, `ownership_conflict`, …).
JSON refusals are `{ status: 'refused', outcome, code }` with the backend's
status mapping; a lost or 503 reply is 503 `{ status: 'unavailable' }`.

- **Intent and origin.** Every start and every state change is a POST whose
  `Origin` is the public site (and `Sec-Fetch-Site: same-origin` where sent),
  and it needs the expected-viewer header the www guard adds (409 otherwise).
  The `.boardsesh.com` session cookie rides on any top-level request, so it
  proves no intent. The callbacks are the exception; their sealed flow cookie
  and state stand in.
- **Flow custody** (`provider-flow-cookie.server.ts`). The intent, recovery and
  reauthentication tokens and every round trip's state, nonce and PKCE verifier
  (32 random bytes each) live in one cookie, `__Host-boardsesh.provider-flow`:
  AES-256-GCM under a key derived by HKDF-SHA256 from
  `AUTH_BROWSER_SESSION_COOKIE_SECRET` with the label
  `boardsesh-provider-security-flow-cookie-v1`, the cookie name as associated
  data; HttpOnly, Secure, Path=/, no Domain, at most 15 minutes; SameSite=Lax,
  or None for an Apple link (Apple answers by `form_post`). It is cleared with
  the attributes it was written with, and a seal larger than the reader
  accepts (3,072 characters) is never written: the intent is aborted and the
  answer is 503. The PKCE verifier and every backend token stay sealed. The
  state, the nonce and the S256 code challenge are part of the authorization
  URL, which the JSON `redirect` answer hands to page JavaScript to follow;
  that is what an OAuth redirect is, and none of them lets anyone redeem the
  code without the sealed verifier. The preparation token lives only inside
  the one request that prepares and finalizes. The record names the account
  and session that started the flow; every later step and callback compares
  them with the session the request presents now (`identity_changed`, flow
  cookie cleared, otherwise), and the backend compares the presented token with
  the one the intent stores.
- **Round trips** (`provider-oidc.server.ts`). www's own start and callback,
  never `/api/auth/signin/*`. Endpoints and client credentials come from the
  providers NextAuth is configured with. Each round trip sends state, nonce and
  an S256 PKCE challenge; the callback redeems the code with the verifier and
  checks the ID token's RS256 signature against the issuer's keys, issuer,
  audience, authorized party, expiry, issue time and nonce. The flow hash
  bound to the intent is the SHA-256 of
  `["web-oauth-provider-link-state-v1", provider, state]` for a link and
  `["web-oauth-google-reauthentication-state-v1", state]` for a Google
  reauthentication, computed from the state the callback carried, never from
  the sealed copy; a sign-in's tag is `web-oauth-google-nonce-v1`, and a
  sign-in's callback cannot open this flow cookie, so neither can finish the
  other. A callback whose state matches no round trip of the flow ends
  nothing (`state_mismatch`).
- **No session cookie (HARD RULE 2).** No reply of these routes sets or clears
  a session cookie of any name. A link or unlink keeps the session's token and
  sign-in time and moves its generation: the JSON answer carries
  `refreshAccessToken: true`, and the page fetches a new 15-minute token
  (`refreshAccessTokenAfterCredentialChange`) without a reload; a callback's
  303 is a full page load, which fetches one anyway. Access tokens minted
  before the change are refused, and every other session of the account ends
  server-side. The legacy twin keeps its older generation, so after a link it
  is dead (see "Rollback after a link or unlink" above).
- **Legacy-only browsers.** A request that presents only a legacy cookie gets
  403 `canonical_session_required`; the page re-reads the session (which
  bridges it) and retries once.
- **Apple link is on wherever Apple is configured.**
  `provider-security-apple-link.integration.proof.ts` drives its `form_post`
  round trip against the Apple stand-in: the POST carries only the
  SameSite=None flow cookie and is held in the resealed flow cookie (303 to
  `?resume=1`, no session cookie); the same-site GET redeems the code,
  verifies the RS256 ID token and commits the link with the same session
  token and id at the next generation, ending the account's other sessions; a
  mismatched state, an empty resume, another account's session and a
  cancelled answer link nothing. The Settings card shows Connect Apple from
  `methods.linking` with no change. Apple still cannot reauthenticate (no
  backend verifier). `B5E1_APPLE_LINK_PROOF` left the www list with it.
- **Failed round trips give their slot back.** A code exchange that fails
  (`provider_not_verified`), a provider with no client, and any refusal that
  ends the flow call `abort` before clearing the flow cookie, so failures never
  pile up to `too_many_pending`. A cancelled Google reauthentication keeps the
  intent, so the climber can still use the password; a cancelled link ends it.
  The issuer's signing keys are cached for an hour and fetched again on an
  unknown `kid`.
- **Lost replies.** A lost or 503 `finalize` reply is followed by one `recover`
  with the same session; `recovered` counts as committed. When that is lost
  too, the flow cookie stays, the answer is `unavailable`, and `POST recover`
  can ask again. `too_many_pending`, `reauthentication_required`,
  `identity_changed` and lost replies change no cookie; a wrong password keeps
  the flow so the climber can try again.

### Forced re-sign-in (B5e1)

`/auth/reauthenticate?callbackUrl=…` (#7655 item 6).
One page for Settings, the developer console and partner pages, under
`better-auth` only (404 otherwise; signed-out browsers go to the login page
first). It is a real sign-in of the account already signed in: its password
through the credentials login, or Google through the sign-in route with
`max_age=0` and `prompt=select_account consent`. Either is a login, so the
backend issues a new session whose sign-in time is now (Google only with a
signed `auth_time` under five minutes old) and ends the old one, and the
browser returns to the `callbackUrl`, reduced to a same-origin path
(`safeCallbackUrl`). A silent Google sign-in cannot satisfy a five-minute
check. Apple-only accounts are told to set a password first.

It ends as the account that started it, or not at all. Before the sign-in,
the page POSTs `/api/auth/reauthenticate/start` (same `Origin`, the
expected-viewer header), which writes `__Host-boardsesh.reauthenticate`:
sealed like the provider flow cookie (its own HKDF label), HttpOnly, Lax, ten
minutes, holding `startedAs` (the signed-in user id) and the return path. Both
sign-ins come back to `GET /api/auth/reauthenticate/return`, which clears it
and forwards to the return path only when the browser is now signed in as
`startedAs`. Another account (Google offered a different one and the climber
picked it) goes to `/auth/reauthenticate?outcome=other_account`, which says so
and offers Sign out and the home page; a missing or expired record goes to
`outcome=expired`. Neither value can be chosen through a URL. An unknown
Google account ends on `link_required`; while a re-sign-in is in progress the
error page says that Google account is not connected to this Boardsesh
account and offers to try again, instead of the Settings advice. The Google
start sends the account's email as `login_hint`; Google preselects it only
when it is the connected address (the backend does not store the Google
address, so nothing better is known). The page shows sign-in buttons only from
a successful `methods` read (a legacy-only browser re-reads the session and
asks once more); any other answer is an error with a retry, so an Apple-only
account is never offered Google. A wrong password, a rate limit (429) and an
outage each get their own message.

Return to app.boardsesh.com is not supported: `callbackUrl` is reduced to a
path on www (`safeCallbackUrl` without an origin), so an absolute Expo web URL
falls back to `/`. Nothing on app.boardsesh.com sends climbers here today; if
it ever does, that return needs its own allowlist.

Deploy order: `link_required` is a new value in the `resolve` reply. A www
without it refuses such a reply and shows the outage page, so www deploys
before the backend or with it.

Settings' link
and unlink use the per-intent reauthentication of the provider-security
commands instead, which does not touch the session's sign-in time; the console
and partner pages need the session's own sign-in time, which only a login
moves. The page asks the provider-security `methods` read which ways the
account can confirm, and offers both when it does not answer.

Owner check against real Google, before the mode goes on: Google accepts
`max_age=0` with `prompt=select_account consent` (no 400), asks for the
password, and the ID token's `auth_time` moves to that moment (#7590).
`web-provider-session.integration.proof.ts` proves the rest against the
stand-in: the start sends both values, the answer is a login with its twin,
and only a fresh `auth_time` passes a five-minute check.

**Owner checks for link, unlink and reauthentication against the real providers** (none of this has been seen
outside the stand-in):

1. Register `https://www.boardsesh.com/api/auth/provider-security/callback/google`
   as a redirect URI of the Google client and
   `https://www.boardsesh.com/api/auth/provider-security/callback/apple` as a
   return URL of the Apple service id.
2. Google accepts `max_age=0` with `prompt=select_account consent` (no 400),
   asks for the password, and the ID token's `auth_time` moves to that moment.
   Record it in #7590.
3. The `__Host-` flow cookie comes back on Google's redirect (SameSite=Lax) and
   on Apple's `form_post` (SameSite=None) in Chrome, Safari and Firefox, and in
   the iOS and Android in-app browsers.
4. A link and an unlink on real Google; on real Apple, a link (Apple only
   links; it cannot reauthenticate).

`provider-security-link.integration.proof.ts` and
`provider-security-unlink.integration.proof.ts` drive these routes over the
real backend handlers, real PostgreSQL and the Google stand-in: a link keeps
the token, moves the generation, ends a second session, writes no session
cookie, and the old access token is refused while a new one works; another
account's session holding A's flow cookie is refused at a step and at the
callback; a sign-in round trip cannot finish a link and the reverse; a
mismatched and a replayed callback are refused; a lost `finalize` reply is
recovered; reauthentication by password and by a fresh Google sign-in work, a
Google sign-in older than five minutes does not; the last sign-in method stays;
the mode unset answers 404. Apple is not driven end to end.

**What B5e2 builds on this** (done, below). The Settings card (linked identities from
`methods`, connect and disconnect buttons that POST `start` and then
`reauthenticate/password` or `reauthenticate/google`, follow `redirect`,
call `refreshAccessTokenAfterCredentialChange` on `committed`, re-read the
session and retry once on `canonical_session_required`, and read
`providerSecurity` on return) and the first-password page for accounts
without a password. It removes `B5E2_WWW_PROVIDER_SETTINGS_UI` from the www cutover
list.

### Settings and first password on www (B5e2)

**Sign-in methods card.** Under `better-auth`, and only when www's
`CURRENT_STORE_PROVIDER_SECURITY_MODE` is `backend-staging` too, the www
Settings page shows the card "Sign-in methods" in place of the set-password
card (`sign-in-methods-section.tsx`). Otherwise the page is as before, pinned
by a test. It reads `methods` and shows the password state and each
configured provider: connected (Disconnect), not connected (Connect), or "Not
available yet" (a provider `methods` reports not linkable for a reason
other than `not_configured`; Apple link is on since #7880). The only sign-in method
cannot be disconnected and says why. A change runs `start`, then the password
or "Continue with Google" (which follows the returned redirect), then the
result: `committed` fetches a new 15-minute token
(`refreshAccessTokenAfterCredentialChange`), reads `methods` again and says
so; a wrong password keeps the flow; `unavailable` asks `recover` once, and
when there is nothing to recover (the backend answers 503 past five
reauthentication tries a minute per account) the flow stays open with "try
again in a minute"; `identity_changed` reloads from the locale root; every
other refusal has its own message, and the route aborts the intent of any
flow it ends, so closed flows never pile up. `too_many_pending` offers
"Cancel pending changes", which aborts this browser's open change. Back from a provider, the card reads `providerSecurity`
(and `provider`) from the address, says what happened and removes both. Every
call goes through the www guard (expected-viewer header) and re-reads the
session once on `canonical_session_required` (`account-security-client.ts`).
Every account without a usable password is offered "Set a password", a link
to `/settings/first-password` (decision of 2026-11-18 on #7596: first
password is open to any account with no password and a Google or Apple
identity). Connect and Disconnect stay enabled whenever the account can
confirm a change (a password, or a fresh Google sign-in). The backend
accepts them (`isFirstPasswordInventory`), with a durable cap of 5 emails an
hour and 10 a day per account; the www proof drives a Google-only account end
to end.

**First password** (`first-password-route.server.ts`). Routes under
`/api/auth/first-password/*`, all POST with this site's `Origin`, the
expected-viewer header, the raw `Cookie` header and the canonical session only;
404 with the mode unset, 503 unless www's `CURRENT_STORE_FIRST_PASSWORD_MODE`
is `backend-staging`; no reply writes a session cookie:

| Step | What it does |
|---|---|
| `request` | Backend `request` for the live session; www seals the `__Host-boardsesh.first-password-flow` cookie (challenge and recovery tokens, the account and session that asked; ids capped at 128 characters) first, then emails the plan's link through `@boardsesh/email` (`sendFirstPasswordConfirmationEmail`). The link's origin is the configured canonical origin only: with none configured every step answers 503. No email, no cookie: asking again supersedes the challenge |
| `status` `{ operation }` | Whether the emailed link belongs to this browser and session; backend `read` (no write) |
| `confirm` `{ operation, token, password, confirmPassword }` | Backend `prepare` then `finalize`; on a lost reply one `recover`. `committed` carries `refreshAccessToken: true` |
| `recover` `{ operation }` | Asks `recover` with the sealed preparation token |

The emailed link is `/auth/confirm-first-password#token=…&operation=…`. The
fragment never reaches a server, so the GET changes nothing; the page takes
it out of the address, asks `status`, and shows the password form. A link
opened in another browser (no flow cookie, or another operation key) answers
`other_browser`; one opened by another account or another session of the same
account answers `other_account`; both change nothing and the page says what to
do. The operation key is a digest of the challenge, never the challenge. The
same session that asked must finish (the backend checks the token hash too).
The page `/settings/first-password` asks for the email ("we sent you a link").
The confirmation page loads no product analytics (`isProductAnalyticsFreeUrl`),
and telemetry redaction also covers the `status`, `confirm` and `recover`
route names. A lost `prepare` reply keeps the password form for another try.

`first-password.integration.proof.ts` drives the routes over the real backend
handlers and real PostgreSQL (only the mail transport is replaced, to read the
link): the password is set, the session keeps its token and moves its
generation, a second session ends, the new password signs in; the link fails
for another session, another account and another browser; a replay is
refused; a lost `finalize` reply is recovered; a legacy-only browser gets
`canonical_session_required`; the mode unset answers 404.

## What is removed, and why

Behind the eight gates sits a second design: host-only `__Host-boardsesh.*`
cookies, a server row per browser (the "binding"), 120-second `bsbd1_` leases
for app.boardsesh.com, per-request receipts and exact-ACK cookie publication.
Its own doc calls its founding rules "agent engineering decisions"
(`docs/auth/better-auth-session-publication.md:16`); no owner decision covers them.
It needs every HTTP and GraphQL call site wrapped by hand (57 of 202 GraphQL
sites are done), and it already caused a live native regression (climb delete,
from #7547). #7596 estimates 50 to 80 agent-days to finish it, against 15 to 25
for this design, which deletes about 22,000 source and 45,000 test lines.

A4 deletes the per-site wrappers and scopes in `packages/mobile` and
`packages/shared` and the selected outbox drain from #7555, which no platform
can reach (#7592). A5 deleted the web side of the browser binding (B5d later
removed its backend core), proof cookies, the www iframe coordinator, renewal
custody, expired-binding recovery, `bsbd1_` leases, receipts, the web
provider-flow publication layer, and the binding-based browser-to-native
handoff (`bsnh1_`, #7510 and #7529). The legacy native callback keeps its
behaviour and responses byte-for-byte: A5 removes only its selected-handoff
imports and branch (`app/api/auth/native/callback/route.ts:12-13,52-67`), and
the HMAC transfer (`app/lib/auth/native-oauth-transfer.ts`) is untouched. Each
doc marked "Superseded by #7596" goes in the PR that deletes its code. The
binding was never on in production, so deleting it carries no rollback risk.
The PRs that delete it close
[#7588](https://github.com/boardsesh/boardsesh/issues/7588) and
[#7594](https://github.com/boardsesh/boardsesh/issues/7594).

The last web piece of the binding went in one A5 PR: the www binding command
client, the presented-selection reader, the proof-cookie codec with its
Chromium proof, and the last web readiness gate
(`browser-consumer-readiness.ts`). Nothing on www imported any of them except
each other and their tests. The same PR deleted the backend's private binding
route (`/api/internal/auth/browser-binding/v1/*`, now the ordinary 404) and its
HTTP proof, because the deleted www client was its only caller. It also
deleted the shared `@boardsesh/auth-protocol` modules the deleted www and Expo
web clients used: the four iframe coordinator subpaths (`browser-coordinator`,
`-runner`, `-channel`, `-dom`) with the renewal message schema they shared,
`browser-delegation-v1`, and the ten `browser-backend-*` lease, HTTP and
WebSocket modules. Nothing outside the package imported them any more, and
`packages/mobile` no longer depends on the package. B5d then deleted the
backend binding core (`authority/browser-binding.ts`),
`@boardsesh/auth-protocol/browser-binding-v1` and
`CURRENT_STORE_BROWSER_BINDING_MODE`; the `private-browser-v1` database
profile and the binding tables stay (no migration). One dead branch also stays
on phones: `isCancellation` in `packages/mobile/src/lib/error-reporting.ts`
still drops a `BrowserBackendConsumerError` whose status is `superseded`, and
`packages/mobile/src/lib/__tests__/error-reporting.test.ts` keeps a stand-in
class for it. A5 deleted the `browser-backend-consumer` module that defined
the error, so nothing throws it, but the file has no `.web` suffix and ships to
phones by OTA, so the backend-only Phase B PRs leave it alone; a mobile PR
deletes the branch, the stand-in class and the test case that uses it.

Kept, per #7596: BA-04 cutoffs, SID denials and the legacy bridge; BA-06
native and Garmin work; the backend provider and first-password cores. Some
web files mix live and dead parts, and A5 splits them instead of deleting them:

1. `withAuthResponseAdmission` (`[...nextauth]/route.ts:316`) checks the BA-04
   SID denial on session reads and sign-out today
   (`auth-response-admission.server.ts:81,110`). That check stays.
2. The same-origin cookie fetch lock (`nextauth-cookie-fetch-lock.ts:255`)
   stays until Phase B.
3. The CNC mount and version fence (`app/build-plans/use-cnc-request-scope.ts:11-34`)
   is not binding code and stays.
4. Private server renders read the session through `getAdmittedServerSession`
   and `getAdmittedRawServerToken` (`admitted-session.server.ts`). A5 removed
   their selected branch and deleted `getServerRenderViewer`, which had no
   caller left after #7621; the legacy path is unchanged.

A5 also removed the 503 that the selected branches of every `/api/auth/*` call,
ws-auth, the native callback and private server renders gave any
`__Host-boardsesh.browser-binding*` cookie, so a browser that still holds one
signs in through the legacy cookie (#7594). The old cookies are left alone: the
binding was never on in production, no live www path reads them, and they
expire within 30 days. Until then a stale `__Host-boardsesh.browser-proof.*`
cookie still counts toward the Google and Apple Cookie-header limits below.

Deletions must not change live behaviour. One known live effect: in legacy
mode, Google and Apple sign-in answer 503 when the Cookie header is malformed
or too large (over 32,768 bytes, over 128 pairs, control characters, or a pair
without a name). A5 keeps an equivalent check and says so in its PR: since the
route surgery it is `isAcceptableProviderOAuthCookieHeader`
(`provider-oauth-cookie-header.server.ts`), answered at the top of
`composedAuth` in `[...nextauth]/route.ts`. The old Google/Apple outer route,
ws-auth and the native callback also refused any `__Host-boardsesh.*` cookie,
which only the binding design sets; that part goes, as #7594 asks.

## Tests

Failing test first for new behaviour; real HTTP (a local `node:http` server),
real `fetch` and real Postgres where possible; no test forces a readiness gate
on while it scripts the backend's replies; no test file over about 600 lines.
Web tests have no jest-dom, so they assert DOM properties directly.

| #7596 acceptance item | Test |
| --- | --- |
| 1. Chromium and WebKit on real HTTPS subdomains: renewal, sign-out, set-password and session reads emit no `Set-Cookie` | B1 backend tests over real HTTP for the after-hook. B7 Playwright on both engines. Rerun the fixture in [the cookie-order doc](better-auth-browser-cookie-order.md). |
| 2. www and app open as A, log in as B on www: A's token gets a 401 and the app tab reloads as B | A3 latch and reload tests. B1 revocation test. B7 Playwright. |
| 3. A response held across an account switch, then back/forward: no toast, navigation or cache write under B | A2 and A3 tests that hold a real server's response body across a switch. B7 Playwright for the Router Cache and back/forward cache. |
| 4. Set-password on a bridged session requires reauthentication | B2a: a bridged session reads as `source: 'bridge'` and fails `requireFreshAuthentication` and `webSignInProof` even from a sign-in 15 seconds old (`web-session-bridge.test.ts`). Set-password still takes the legacy cookie until B4b moves it to the canonical session. |
| 5. A browser signed in before cutover stays signed in, with every legacy cookie shape | B2a: every claim shape the backend receives (session id with and without a stamp, `legacy_no_sid`, no session id, a fresh link-guarded sign-in, a value joined from several chunks). B2b and B4 per cookie name, including the conflicting host-only and domain pair. B7 Playwright. |
| 6. Rollback leaves every browser signed in through the legacy cookie, with no clearing step | B7 Playwright that switches the mode back, including a browser that logged in after cutover. |
| 7. Native iOS and Android unchanged; no abort on unmount; no new identity per render | A3 and A4 tests that run each flow with the platform set to `ios` and `android`. `src/__tests__/web-fork-export-parity.test.ts`. The mobile suite in CI. |
| 8. One mode switch gates the whole web cutover | A5: parser tests in `@boardsesh/auth-protocol` (`browser-session-mode.test.ts`), and backend tests that `startServer()` refuses an unknown value and `better-auth` before any startup I/O (`authority/__tests__/browser-session-mode.test.ts`). No `*-readiness.ts` gate is left. B4 adds the www reader. |
| #6979 criterion 4: an outage keeps the local session | A2: a session read answering 503 causes no reload and no cleanup. A3: a session read reporting "unavailable", or a peer `credential-rotation` hint, retires nothing. |

The other #6979 criteria map onto the items above: criterion 1 is item 5,
criterion 2 is B4 and B5, criterion 3 is items 2 and 3, and criterion 5 is B4.
Unit tests cannot show real cookie order across www and app, the back/forward
cache or the Router Cache; only B7 can. There is no account-switching browser
test in `packages/web/e2e/` today.

## Browser-session e2e harness

`vp run test:e2e:browser-session` runs www and the Expo web app on two real
HTTPS subdomains of one parent domain, in Chromium and WebKit, against the real
backend and the dev Postgres. B7b to B7d put the acceptance specs on it. It
needs the dev database (`vp run db:up` runs as a task dependency) and
`vp exec playwright install chromium webkit` once. Add `-- --project=webkit` to
run one engine, and `BROWSER_SESSION_E2E_REUSE_EXPORT=1` to skip the Expo
export when one is already built. The workflow `browser-session-e2e.yml` runs
it nightly, on dispatch, and on a pull request that touches the harness or the
web or backend auth it exercises, always against a production build of www
(below).

What starts, from `scripts/browser-session-e2e.ts` and
`packages/web/e2e/browser-session/global-setup.ts`:

| Host | Served by |
| --- | --- |
| `https://www.boardsesh.test` | `next start` on a production build (CI), or `next dev` (a local run's default), with `NEXTAUTH_URL` on that origin and `AUTH_COOKIE_DOMAIN=.boardsesh.test` |
| `https://app.boardsesh.test` | the standalone Expo export (baseUrl `/`, SPA fallback), with the www, app and backend origins baked in |
| `https://ws.boardsesh.test` | the backend (`src/index.ts`), with `BOARDSESH_URL` and `APP_ORIGIN` set to the two origins above |

**How the browsers reach the hosts.** One TLS edge (`partner-oauth-e2e/edge.ts`,
shared with the partner OAuth journey) holds a self-signed certificate for all
the hosts, generated at run time under the ignored `.boardsesh/browser-session/`
and deleted at teardown, so no key is committed. Each Playwright context is
given the edge's HTTP proxy (`fixtures.ts`). The proxy answers CONNECT only for
these hosts, so the browser never resolves the names and nothing needs
`/etc/hosts`, `--host-resolver-rules` or a root-owned CA. It is the same
mechanism in Chromium and WebKit, because both honour a per-context proxy.
`ignoreHTTPSErrors` trusts the certificate. `.test` is reserved (RFC 6761), so
the names can never reach a real site.

**No new production override.** The parent cookie domain comes from the existing
`AUTH_COOKIE_DOMAIN` (`secure-cookies.ts`), and the origins from the existing
`NEXT_PUBLIC_APP_URL`, `APP_ORIGIN` and `BOARDSESH_URL`. The only code change
outside the harness is that the partner journey's local-only check accepts
`.test` hosts (`server-environment.ts`).

**What the specs check.**

- `cookie-domain.spec.ts` asks each engine, with no Boardsesh code involved,
  whether a `__Secure-` cookie with `Secure; HttpOnly; SameSite=Lax;
  Domain=.boardsesh.test` set by one host is stored, sent to a sibling host,
  and removed by an expiring `Set-Cookie`, and that one without a `Domain`
  stays on its host. Public-suffix rules and `Secure` handling with ignored
  HTTPS errors differ by engine, so this is tested, not assumed. Result, first
  run (PR #7767, Playwright 1.62.1 on Linux): all three pass in Chromium and
  WebKit, so `.boardsesh.test` is a registrable domain in both and a `Secure`
  cookie is stored and sent over the ignored-error certificate. When another
  spec fails in only one engine, read this one first.
- `legacy-mode.spec.ts` is the baseline in today's mode
  (`AUTH_BROWSER_SESSION_MODE` unset): sign in on www as the seeded test user
  (`test@boardsesh.com`), open the app subdomain in the same context and see
  the same `userId` and `authSessionId` from www's cookie route, then sign out
  on www and see the app tab show the sign-in form after a reload. It skips
  itself when `AUTH_BROWSER_SESSION_MODE` is set.

The global setup forwards `AUTH_BROWSER_SESSION_MODE` from the caller's
environment when it is set, so a Phase B spec can run the same stack under
`better-auth`. Server logs and the HTML report land in
`packages/web/test-results/browser-session/` and
`packages/web/playwright-report/browser-session/`.

### What a spec can use

Fixtures from `packages/web/e2e/browser-session/fixtures.ts`, each with a spec
that shows it working in legacy mode in both engines:

| Fixture | What it gives a spec | Spec |
| --- | --- | --- |
| `accountA`, `accountB` | `{ userId, email, password, name }` for the dev database's test user and a second account made at global setup (`database.ts`: the same two inserts the partner journey uses, deleted at teardown). `openContext()` opens another context set up like `context`. Sign in with `helpers.ts` `signInOnWww(page, account)`. | `accounts.spec.ts` |
| `edgeCookies` | `begin()` then `end()`, or `during(action)`: every response the edge relayed in the window, as `{ host, method, path, status, setCookies: [{ name, attributes, clears }] }`. Names and attributes only, never a value (`edge.ts` drops it). A response with no Set-Cookie is still listed, so "emitted none" differs from "never ran". `sessionSetCookies(records)` keeps the session cookies. | `set-cookie-recording.spec.ts` |
| `legacySession.addTo(context, account, shape)` | A NextAuth cookie minted with `encode` from `next-auth/jwt` and the run's `NEXTAUTH_SECRET`: `normal`, `chunked` (three `.0` to `.2` pieces), `host-only` (no Domain, www only) or `plain-named` (`next-auth.session-token`, no `Secure`). Returns the cookie names. | `legacy-session.spec.ts` |
| `restartStack({ env, backendEnv, webEnv })` | Stops both servers and starts them again with `env` set over the run's own environment on both, and `backendEnv` or `webEnv` on one (null unsets; no argument goes back to it). The database, edge, browser contexts and ports stay. The setup process does it, so the specs reach it through a loopback control server with a per-run token. A start that fails rejects with the last lines of the failing server's log, so a spec can assert a refusal code. Allow minutes under `next dev`. | `restart.spec.ts`, `acceptance-8-one-switch.spec.ts` |
| `freshAccount()` | A new account for one test, made through `database.ts create` (the same two inserts as account B), with its own id under the run's prefix, so teardown deletes it with B. Tests that sign in, switch and sign out use their own accounts, so no test revokes another's session or shares its rate-limit history. | the acceptance specs |
| `accountDatabase` | Steps on a run's own account: `removePassword` (a climber who only used Google), `ageSession(account, sessionId, days)` and `sessionExpiry(account, sessionId)` for the renewal check, `firstPasswordAccount(account)` (no password, a Google identity, an `@example.test` address and its owned reservation: the rows the backend's first-password proof makes) and `hasPassword(account)`. | `acceptance-1`, `acceptance-4` |
| `mailbox` | What the run's mail sink took (`mail-sink.ts`, under `better-auth` only): `firstPasswordLink(email)` waits up to 20 s for the emailed first-password link and returns its token and operation key; `count(email)`. The sink is an SMTPS listener on 127.0.0.1 with the run's certificate and its own user and password; www's shared mailer sends to it unchanged, and it delivers nothing anywhere. | `acceptance-4-first-password` |
| `responseHolds` | `arm({ host, method, path })` holds the next response to that request at the edge after the server answered it; `untilHeld()` waits until it is held, `release()` delivers it. One-shot; teardown releases every hold. The browser stores a held reply's `Set-Cookie` only on release. | `cookie-order` |
| Google and Apple stand-ins | `auth-proofs/google-oidc-fixture.ts` and `apple-oidc-fixture.ts`, started by the global setup: their sign-in pages on `accounts.google-stand-in.test` and `appleid.apple-stand-in.test` (other sites than the parent domain, so Apple's `form_post` reaches www cross-site), their token and key endpoints on loopback for www. Both services get a client for each; www's providers read the stand-ins through `BOARDSESH_E2E_GOOGLE_OIDC_WELL_KNOWN` and `BOARDSESH_E2E_APPLE_OIDC_WELL_KNOWN` (`oidc-stand-in.server.ts`: honoured only when `NEXTAUTH_URL` is an https host under `boardsesh.test` and no hosting platform runs www; set anywhere else, www does not boot). `signInWithGoogle` and `continueWithApple` (helpers.ts) press www's own buttons, or, for a browser already signed in, send the request those buttons send. With no Google auth-time mode on the backend, a Google sign-in here is `carried`. | `provider-sign-in`, `cookie-order` |

Legacy mode rewrites the session cookie on every `/api/auth/session` read, as
well as at sign-in (both show in `set-cookie-recording.spec.ts`), and
`/api/internal/ws-auth` writes none.

**www as a production build.** `BROWSER_SESSION_E2E_WWW=production` (or
`vp run test:e2e:browser-session -- --www-production`) runs `next build` and
`next start` instead of `next dev`. Router Cache behaviour and several auth
branches differ under `NODE_ENV=production`, so CI runs only this: every pull
request run and the nightly. `next dev` stays the local default and a dispatch
option (`www=dev`). The build writes `packages/web/.next`, so do not start it
while `vp run dev` is running.

**404s after a `next dev` restart: a harness artefact, fixed.** In run
44314377751, after a `restartStack`, `next dev` answered 404 for routes that
exist (`/auth/login`, `/api/auth/session`) once it recompiled. `next dev` keeps
a Turbopack cache on disk (`turbopackFileSystemCacheForDev`, on by default in
Next 16) and writes it while it runs; the harness stops the dev server with a
signal mid-run, and the next server started on that cache. No production build
run (`next start`, no such cache) showed it across the same restarts, and no
deployment restarts `next dev`, so it is not a product bug. Each dev start now
deletes `packages/web/.next/dev` first (`servers.ts`). Not reproduced locally;
the evidence is that run's log.

**Retries.** Playwright retries are off for Chromium (`retries: 0`): this
suite tests races, and a blanket retry would hide one. The harness retries
three named infrastructure errors once each (`harness-retries.ts`): a
`restartStack` that timed out waiting for www; WebKit failing a navigation, its
document or one of its scripts with "internal error" (the navigation is tried
again; run 44329764195 left a tab black that way); and WebKit's network
process losing a context (`webkit-network-process-lost`). In that last case
every load in flight fails at once with "internal error" (in each run that hit
it: the app's session read, its icon font and its splash image, on two hosts
at the same instant) and the context's cookies are gone with it, so the tab
reads as signed out and nothing in the test can recover; runs 44339770816,
44345728475 and 44351039908 each lost one WebKit test that way. The harness
sees it as the consent cookie every context starts with going missing, logs
the marker, and the WebKit project may run that test once more
(`retries: 1`); `harness-retry-reporter.ts` fails the run when a test ran
again after an attempt that did not log the marker, so any other failure
still fails the run. Every request WebKit fails is logged with its URL
(`[webkit] request failed`). Each retry logs a `[harness-retry]` line, and
teardown fails the run when there were more than two.

**Probes.** `websocket.spec.ts`: the app tab opens `wss://ws.boardsesh.test/graphql`
through the proxy and gets `connection_ack`, in both engines. `bfcache.spec.ts`,
below.

**Back/forward cache.** From playwright-core 1.62.1: Chromium is launched with
`--disable-back-forward-cache`, so no Chromium page is restored from the cache.
Dropping that flag is not enough with the default headless shell, which reports
`BackForwardCacheDisabledForDelegate`. The `chromium-bfcache` project uses the
full Chromium build (`channel: 'chromium'`) with
`ignoreDefaultArgs: ['--disable-back-forward-cache']`, and a back navigation
there fires `pageshow` with `persisted: true`. The other Chromium project stays
`false`. WebKit's launcher passes no such flag, and its Linux build fired
`persisted: false` in the first CI run; I found no supported switch for it, so a
spec cannot rely on a WebKit restore. `chromium-bfcache` runs only
`bfcache.spec.ts` and `acceptance-3-back-forward.spec.ts`. On the production
build Chromium keeps a signed-in `/help` (no `no-store`) and never keeps
`/settings`, which is served `no-store` (`notRestoredReasons`:
`response-cache-control-no-store`); the spec asserts both. A restored page runs no
script and sends no request, and `goBack` must wait for `commit`, since a
restore fires no `load`.

### The acceptance run under `better-auth` (B7b)

`AUTH_BROWSER_SESSION_MODE=better-auth vp run test:e2e:browser-session` starts
both servers in the new mode. The global setup does three things first:

1. **The database.** `browser-session-e2e-database.ts` (a backend test fixture,
   run with tsx from `packages/backend`) creates the `boardsesh_identity_writer`
   LOGIN and grants it the `private-first-password-v1` contract with the
   credential-writer fixture CI's `test-credential-writer` job uses, then makes
   the authority manifest `enforced` the way the backend suites do
   (`prepareProjectionUnderUsersTableLock`, then the phase). The private web
   commands open their database only through that LOGIN, and the staged writers
   need the enforced manifest. Both change the database for good, so the step
   runs only on CI or with `BROWSER_SESSION_E2E_PREPARE_DATABASE=1` on a dev
   database you can recreate. The narrower `private-web-v1` contract does not
   qualify on the current schema (0313 onward), as the credential-writer doc
   says.
2. **Every precondition** both startup checks read
   (`better-auth-environment.ts`): the staged web auth, OAuth, session and
   set-password modes, proof mode `required`, cutoff enforcement, the RPC
   secret, projection id and writer epoch, the deleted-email key, the cookie,
   access-token and bridge-token secrets (all made for the run, all
   different), `AUTH_LEGACY_BRIDGE_UNTIL` 30 days ahead, and the credential
   LOGIN's URL. Nothing forces a check to pass.
3. **One https channel** from www to the backend (`backend-relay.ts`): the
   private command transport takes plain http only from loopback under
   `NODE_ENV` development or test, so the production build of www needs
   https, as production does. The relay terminates TLS on 127.0.0.1 with the
   run's certificate, which www trusts through `NODE_EXTRA_CA_CERTS`.
4. **A mail sink** (`mail-sink.ts`) for www's shared mailer, over TLS with the
   same certificate (`SMTP_HOST=127.0.0.1` and the sink's port, user and
   password on www only), so the emailed first-password link can be read
   without an inbox and without changing the product.

The one test-only switch is `BOARDSESH_E2E_BROWSER_SESSION_CUTOVER=allow`,
which empties the backend's and www's cutover blocker lists, and only when the
service's own origins are https hosts under `boardsesh.test`; set anywhere
else, both services refuse to start ([rollout doc](./better-auth-rollout.md),
section 4).

| Spec | #7596 acceptance item | Engines |
| --- | --- | --- |
| `acceptance-1-reads-write-no-cookie.spec.ts` | 1: reads, csrf, ws-auth, private pages and set-password write no session cookie and no viewer marker; the login writes the marker with its session's value and the session cookie's scope, readable on www and the app, and sign-out clears it in both scopes; the bridging read writes exactly the bridged cookie and its marker; renewal rolls the row with no cookie | Chromium, WebKit |
| `acceptance-2-account-switch.spec.ts` | 2: A's token 401, A's socket closed (4401), the app tab reloads as B; #6979 sign-out across subdomains | Chromium, WebKit |
| `acceptance-3-held-response.spec.ts` | 3: A's delete on www (with its toast) and A's GraphQL on the app (a reload of A's profile, whose title is A's name) are held, B signs in on the other host, the reply is released while A's page is up. For 3 s no toast and none of A's data shows in any document the tab holds, and the tab ends as B, reloaded from the root by itself with no focus (the viewer marker; no socket of the app tab reaches the server before the reload, so no 4401 can cause it). A control with no switch shows the same held replies do show A's name | Chromium, WebKit |
| `acceptance-3-back-forward.spec.ts` | 3: on the production build no signed-in page is kept (`no-store`, asserted for `/help` and `/settings`) and back loads B; under `next dev` the page is restored and replaced (`chromium-bfcache` only); Router Cache after a soft navigation (production www only) | Chromium, WebKit, `chromium-bfcache` |
| `acceptance-4-set-password.spec.ts` | 4: with provider security off, a bridged session asks for a new sign-in; a fresh login sets it with no reload or cookie and signs the other browser out | Chromium, WebKit |
| `acceptance-4-first-password.spec.ts` | 4: first password on a bridged session: a made-up link completes nothing; another session presenting the emailed link changes nothing; the session that asked completes it, keeps its session id with no session Set-Cookie, and the other session is signed out | Chromium, WebKit |
| `acceptance-5-legacy-shapes.spec.ts` | 5: normal, chunked and host-only cookies stay signed in with one bridged cookie; plain-named reads as signed out | Chromium, WebKit |
| `acceptance-6-rollback.spec.ts` | 6: rollback to `legacy` and back by restart; the newer legacy login wins | Chromium, WebKit |
| `acceptance-8-one-switch.spec.ts` | 8: two refused preconditions per service, by restart | Chromium |
| `cookie-order.spec.ts` | 1 (the cookie-order fixture, B7c): races of login replies, held reads, a host-only copy, a late bridging reply, held Apple sign-ins; results per engine in [the cookie-order doc](./better-auth-browser-cookie-order.md) | Chromium, WebKit |
| `provider-sign-in.spec.ts` | B5b in a browser: Google and Apple sign-in through www's buttons from a signed-in browser; Apple's cross-site `form_post` held with no session cookie, the same-site GET publishing the login | Chromium, WebKit |
| `app-cold-start-offline.spec.ts` | #6979 criterion 4 on the app: one failed first session read is read again and the app opens signed in; with www unreachable the retry screen shows (never the splash for good) and its retry signs the same account back in | Chromium, WebKit |
| `scripts/check-native-unchanged.ts` (workflow `web-lane-native-unchanged.yml`) | 7: no file that ships to phones changes in the web lane | not a browser test |

**Found by the acceptance run, fixed (decision of 2026-11-18):** www's session
guard learned of a switch only on focus, `pageshow`, a 401, a 409
`viewer_changed` or a same-origin message. A reply of A's released after B
signed in on the other host is a plain 200, so the Settings card showed A's
"Controller deleted successfully" toast (run 44325488834, both engines). The
viewer marker (see "The viewer marker" above) closes it: the guard holds the
reply, the session check names B, the reply is superseded and the tab reloads
as B by itself. The held-reply test runs strict on both hosts.

**Found by the acceptance run, fixed:** the bridged set-password request in
acceptance 1 left out the expected login the Settings card sends in its body,
so the route answered 409 `identity_changed` before it reached the backend's
bridged-session refusal (run 44329764195). A spec fix; the route was right.

**Found by the acceptance run, fixed:** the emailed first-password link opens
a new tab whose status check left before the page's first session read, so
the guard named nobody, the route refused the missing expected-viewer header,
and the page always said "try again". Account-security calls now wait for
that read (`account-security-client.ts`).

**Found by the first run, fixed:** under `better-auth` every www session read
answered 503, because the backend's `session` command joined `user_profiles` on
the credential LOGIN, which may not read that table. The profile's display
fields are now a cosmetic read on the application connection after admission
(`profileDisplayReader`), and `web-session-credential-writer.proof.ts` runs
every web-session command on the real LOGIN in CI.

Every run, pull request or nightly, runs every acceptance spec against a
production build of www, in Chromium, WebKit and `chromium-bfcache`: green,
about 8 to 12 minutes of job time (#7810). `B7_BROWSER_ACCEPTANCE` left both
cutover lists after run 44397800602 passed five attempts in a row on one head
(`45ee32ceae`; attempt 1 had 47 passed and 1 flaky, the one sanctioned WebKit
rerun after a lost context; the others 48 passed and no harness retry). The
nightly first runs the legacy baseline. Google and Apple sign-in in a browser
and the cookie-order rerun are covered since #7880 (the table above). Not
covered here: the partner consent page under the mode (it needs the partner
OAuth journey's own stack, which runs in `legacy`; a follow-up). A lost WebKit
context counts once against the retry budget however many of its pages see it
(`firstLossOfContext`).

What the harness does not show:

- Safari's seven-day cap on a server-set cookie (owner decision 2) cannot
  trigger here. Playwright's WebKit has no intelligent tracking prevention, and
  every host resolves through one proxy to 127.0.0.1, so no site looks
  cross-site to a tracker list. It still needs a real Safari check.
- The back/forward cache differs by engine, as above: no WebKit restore at all,
  and a Chromium restore only in `chromium-bfcache`.
- CI runs www only as a production build. Behaviour that only `next dev` has
  is checked by a local run or a dispatch with `www=dev`.
- One auth mode per run. `AUTH_BROWSER_SESSION_MODE` is read when the setup
  starts the servers, so a spec that needs the other mode calls
  `restartStack({ env: { AUTH_BROWSER_SESSION_MODE: ... } })`, and every
  restart is a cold start for the servers.

## Open questions

1. Session lifetime. Decided 2026-11-17 (decision 2): 30-day rolling, a
   400-day cookie and `rollWebSession` (see "The backend session interface").
2. Bridged freshness. Decided 2026-11-17 (decision 3): never fresh for the
   five-minute checks; the legacy sign-in time still serves the 30-day rules.
3. The bridging read's cookie write. Options: bridge only from a POST the
   guard owns, or skip the `Set-Cookie` when the request's legacy session is
   already denied. Neither has been checked against the cookie-order fixture.
4. Logins after cutover and rollback. Either login also writes a legacy JWE
   for the 30-day window, or climbers who logged in after cutover sign in
   again after a rollback, which needs acceptance item 6 changed.
5. A login that presents an SID-less or `legacy_no_sid` cookie: skip the
   revocation, deny only its lineage, or accept an account cutoff, which ends
   that account's native sessions.
6. Mount `betterAuth()` or write rows, and the BA-02 email gate. A per-request
   instance from `createAuthority` needs a transaction wrapper (the partner
   runtime has one) and BA-02's email stored form (#7436). Writing
   Better-Auth-compatible `auth_session` rows and a signed cookie from our own
   login code, read through `readFirstPartySession` with a `canonical-token`
   (`authority/session-reader.ts:26-29`), avoids the adapter and the email gate.
7. Answered (owner decision 4, 2026-11-17). Cookie-authenticated
   `/api/internal/*` on www now answers 409 when the request names another
   viewer than the cookie; see "Expected viewer on cookie routes" for the
   header, the routes and what stays open (tabs from before the change, and
   soft navigation to private server pages).
8. Expo web navigation. Is unmounting the authenticated tree and reloading
   enough, or does a retired page need a central navigation gate?
9. Under `better-auth`, what do the `CURRENT_STORE_WEB_AUTH_MODE`,
   `_WEB_OAUTH_MODE`, `_SET_PASSWORD_MODE`, `_WEB_SIGNOUT_MODE` and
   `_WEB_CREDENTIAL_PROOF_MODE` selectors mean?
10. Should provider Settings and first password switch on separately from the
    session cutover, or always follow `AUTH_BROWSER_SESSION_MODE`?

## Not verified

Nothing in this doc was run. The Better Auth mechanisms were read in the
installed 1.7.17 source, not executed. Also unchecked: Safari and WebKit handling of the shared-domain
cookie between www and app; live DNS and which hosts receive the cookie;
whether preview deployments are still manual dispatch only; the production
values of `AUTH_LEGACY_BRIDGE_MODE` and the sign-out mode ("off" comes from code defaults); whether
`/api/internal/ws-auth` sets a cookie on any path (A2 checks); and whether the
#7439 denial reader is deployed on every backend. Owner decisions 14 and 23
have no written source other than #7596.

## Related docs

[Accepted migration](better-auth-migration.md), [cookie response
order](better-auth-browser-cookie-order.md), [current lifecycle test
map](better-auth-implementation.md#current-test-map), [legacy web credential
proof](better-auth-legacy-web-proof.md), [first
password](better-auth-first-password-email.md), [Expo web
deployment](../operations/expo-web-deployment.md) ("Browser authentication") and [canonical
web origin](../web/web-canonical-origin.md) (cookie domain rules).
