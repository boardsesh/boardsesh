# Browser sign-in for www and the browser app

This is the design for BA-05 as re-scoped by
[#7596](https://github.com/boardsesh/boardsesh/issues/7596). The acceptance
criteria are in [#6979](https://github.com/boardsesh/boardsesh/issues/6979), the
epic is [#6975](https://github.com/boardsesh/boardsesh/issues/6975), and the
owner's rollout steps live in runbook
[#7430](https://github.com/boardsesh/boardsesh/issues/7430). Where this doc and
an older `docs/better-auth-browser-*.md` disagree, #7596 and this doc win. The
older docs carry a "Superseded by #7596" banner and are deleted with their code.

The design in one sentence: one session cookie on the shared parent domain,
written by login and sign-out (and once by the read that bridges a pre-switch
cookie), plus one guard in each browser client's transport, with no
per-call-site wrapping.

Everything here was read on main `ac54f83751` (2026-11-16): the #7596 spec, the
code, and the installed Better Auth 1.7.17 and NextAuth 4.24.15 sources. File
and line references point at that checkout. Nothing was run for this doc.

## Status

Phase A is in progress. It works against today's NextAuth sessions:

| PR | Work |
| --- | --- |
| A1 | This doc. Banners on the superseded docs, notes on the partly superseded ones. No code. |
| A2, A3 | The central guard on www (A2) and on Expo web at app.boardsesh.com (A3). |
| A4 | Remove the per-site wrappers and scopes from `packages/mobile` and `packages/shared` and restore the plain hooks. Remove the selected outbox drain ([#7592](https://github.com/boardsesh/boardsesh/issues/7592)) and restore the #6302 comments in `invalidation-batch.ts`. The native climb-delete fix, draft [#7599](https://github.com/boardsesh/boardsesh/pull/7599), merges first or A4 rebases on it. |
| A5 (several PRs) | Delete the browser binding design listed under "What is removed", except the backend binding core, which stays until B5. The last A5 PR deletes the last readiness gate and adds the one switch, which the backend checks at startup (see "The switch"). |

Phase B is blocked. #7596 says to stop after Phase A if the BA-04 authority
cannot issue sessions yet, and on main it cannot. Nothing at runtime calls
`createAuthority` (`packages/backend/src/auth/authority/authority.ts:34`), the
bridge was not mounted (B2a now reaches it through the dark private command
`/web-session/v1/bridge`, which nothing on www calls yet), and `issuerFor` always returns `'legacy'` (`authority/router.ts:139-143`); only
tests call the three. The operator script refuses `activate` while three code
gates are listed (`packages/backend/src/scripts/auth-authority.ts:23-30`).
BA-04 ([#6978](https://github.com/boardsesh/boardsesh/issues/6978)) is paused
in #7430, and the BA-02 email PR (#7436) is a draft. Until it lands, the
authority adapter throws on any user whose email is not trimmed lowercase
(`authority/adapter.ts:30-34`), and Better Auth joins the user on every
session read. The only production `betterAuth()` instance is the partner OAuth
server (`auth/partner/authority.ts:167-219`), which reads the NextAuth cookie
and never sets a first-party cookie.

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
  the account read (`docs/db-connectivity.md`, "How much can queue on two
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
| A live session (from the cookie, or bridged) | 200 `{ token, authenticated: true, userId, authSessionId, expiresAt }`; `expiresAt` is the token's end, at most 15 minutes away |
| No session cookie, a conflicted one, an oversized legacy cookie, or a legacy login the bridge denies | 200 `{ token: null, authenticated: false }` |
| A first-party cookie whose session ended (the session read answers `{}` with the `denied` header) | 401 `{ token: null, authenticated: false }`; never a fall back to the legacy cookie |
| A legacy-only browser | Bridged without a cookie (the bridge is deterministic, so the next session read sets exactly that cookie), in its own budget of 20 a minute per client address (`ws-auth-bridge:`), then the token as above |
| Bridge over its budget or failing, an unverifiable first-party cookie beside a legacy cookie, a plain-named legacy cookie in a secure context, backend 503, an unparsed reply, the transport's 401 | 503; the client keeps its session and retries |

Costs: a signed-in ws-auth is two private commands (`session`, then
`access`); a bridging one is four. The www hook refreshes about every 12
minutes per tab, and the provider's identity probe calls ws-auth on focus at
most once every 30 seconds. A legacy cookie under a plain name in a secure
context is never bridged (B2b), so such a browser gets 503 from ws-auth until it
signs in again; so does a browser holding an unverifiable first-party cookie
beside its legacy one.

**www** (`app/lib/auth/browser-access-token.ts`, `use-ws-auth-token.ts`). The
token lives in memory only (React Query data, never persisted). It goes stale
three minutes before its end, so the hook refetches at about 12 minutes, and on
focus or `pageshow` only once fewer than three minutes remain; every caller
shares one fetch per tab. A 503 keeps the token and backs off (30 s doubling to
5 minutes); nothing signs out. A ws-auth 401 asks the session read once and is
not retried. The session guard sends a request the backend refused with 401
once more with one new token, fetched once per refused token for every caller;
a second refusal goes to the session check, which re-reads the session. The
provider's probe treats a ws-auth 401 as "read the session now". A socket is
keyed by a handle that stays the same while the viewer does and reads the
current token at each (re)connect: a 4401 close asks the next connect for a new
token (graphql-ws reconnects and resubscribes), a 1013 reconnects with the
same token. An account change or sign-out seen by the guard drops every token,
and the guard closes the shared socket. After set-password the page asks for a
new token at once. A token without `expiresAt` (legacy mode) is never
remembered, so with the mode off requests and sockets send what they sent
before.

**Expo web** (`.web` files only: `auth-store.web.ts`,
`auth-interceptor.web.ts`). A ws-auth answer with `expiresAt` is refreshed
about three minutes before its end through the one shared session read
(`synchronizeWebSession`), with the same backoff on failure; focus refreshes it
inside the last three minutes despite the 30-second throttle, and a focus probe
that brings a token for the same login replaces the page's own. `ensureFreshToken`
refreshes a token inside its last three minutes before an HTTP request or a
WebSocket handshake; a failed refresh keeps a token that has not ended. The
existing 401 path (one shared refresh, one retry) and 4401 path (refresh, then
reconnect) are unchanged. A ws-auth 401 inside the session/token pair reads the
session again. The legacy JWE has no end and is used as before.

Left for B4a: server renders (`getServerAuthToken`, `getAdmittedServerSession`)
still forward and read the legacy cookie. Moving only the token would let one
render fetch data as one login and show another, so both move together in B4a.
Provider link and unlink have no www page under this mode yet (B5e); they
should call `refreshAccessTokenAfterCredentialChange` as set-password does.

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
[the accepted migration](./better-auth-migration.md) at lines 207-213 ("preserve
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
  cookie, or the bridged row of one) is left alone: ending it would cut off the
  whole account, phones included, so a login never does that and never moves
  the generation.
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
[integration-platform.md](./integration-platform.md), "Who is signed in". Provider link and unlink need
their own reauthentication receipt (`provider-reauthentication-evidence.ts`),
never the session's age, so they did not change. Provider security and first
password compare the actor session's expiry exactly
(`provider-security-context.ts:114`, `provider-security-finalizer.ts:208`,
`first-password-challenges.ts:98`), so a flow that spans a roll is refused.
B5 drops those comparisons when it rebuilds the flows.

What B1 does with the token: put it in the signed session cookie, Max-Age
34,560,000 (decision 2), only after the command answers; never log it or hand
it to page JavaScript. Reads present it back as a `canonical-token` after the
cookie signature check.

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
| Everything else | The legacy path unchanged. Google, Apple and the native transfer still write only the legacy cookie until B4c and B5; when such a reply writes it, both first-party names are cleared in both scopes too, because it is a login and a stale login cookie would otherwise outrank it. |

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
request carries a legacy cookie and no first-party cookie of either name,
verified or not. csrf, a POST session read and every other route never bridge.
A legacy cookie sent twice under one name with differing values (a host-only
copy beside the Domain one), a base name beside chunk names, the plain and
`__Secure-` names with differing values, a conflicted bridged name with no
verified login cookie, and a legacy cookie over 12,288 characters all read as
signed out and bridge nothing. Only the legacy name this deployment writes is
bridged: a plain-named cookie in a secure context gets the legacy answer. Bridging is limited to 20 a minute per client address, keyed
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

### Re-reading the session

Both clients re-read the session on `pageshow` from the back/forward cache, on
`focus` and `visibilitychange` at most once every 30 seconds, and on a 401
(parallel 401s cause one read). Today www lacks the focus and 401 re-reads,
and Expo web lacks `pageshow` and focus. In Phase A every NextAuth session GET
rewrites the cookie, which is the race in
[the cookie-order doc](./better-auth-browser-cookie-order.md), so the extra
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
| WebSockets | The client is disposed on a generation change and reconnects. The server cutoff sweep closes revoked sockets every 1,000 ms ([enforcement windows](./better-auth-enforcement-windows.md)). | A2, A3 |
| Offline outbox | Expo web has none. Native is out of scope and does not change. | none |
| Back/forward cache | `pageshow` with `persisted` re-reads the session. A changed identity reloads. | A2, A3 |
| Next Router Cache (soft back and forward) | No `pageshow` fires. The reload on a change made elsewhere, or the full navigation of this tab's own sign-in or sign-out, drops the cache. | A2 |
| Login on www while an app tab is open | Phase A: the app tab notices on focus, visibility or `pageshow`, because BroadcastChannel and `storage` events do not cross origins. Phase B: the login revokes A's session, so A's next request gets a 401 and the tab reloads as B. | A3, B1 |
| Login on app.boardsesh.com while a www tab is open, which then calls a cookie-only `/api/internal/*` route | The route answers 409 `viewer_changed` before it reads or writes; the guard re-checks at once and the tab reloads as B. A soft navigation to a private server page is not covered (see "Expected viewer on cookie routes"). | Decision 4 |
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
Apple-only accounts set a first password after email confirmation, which is
not provider reauthentication. Facebook sign-in and linking stay removed;
stored Facebook identities stay. The backend `authority/browser-binding.ts` and
the binding-table readers those cores use stay until B5. Drizzle schema exports
and merged migrations stay, and this work writes no migrations.

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

## What is removed, and why

Behind the eight gates sits a second design: host-only `__Host-boardsesh.*`
cookies, a server row per browser (the "binding"), 120-second `bsbd1_` leases
for app.boardsesh.com, per-request receipts and exact-ACK cookie publication.
Its own doc calls its founding rules "agent engineering decisions"
(`docs/better-auth-session-publication.md:16`); no owner decision covers them.
It needs every HTTP and GraphQL call site wrapped by hand (57 of 202 GraphQL
sites are done), and it already caused a live native regression (climb delete,
from #7547). #7596 estimates 50 to 80 agent-days to finish it, against 15 to 25
for this design, which deletes about 22,000 source and 45,000 test lines.

A4 deletes the per-site wrappers and scopes in `packages/mobile` and
`packages/shared` and the selected outbox drain from #7555, which no platform
can reach (#7592). A5 deletes the web side of the browser binding (the backend
core stays until B5), proof cookies, the www iframe coordinator, renewal
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
`packages/mobile` no longer depends on the package. What stays until B5: the
backend binding core (`authority/browser-binding.ts`) and the binding-table
readers the kept provider-security and first-password cores use,
`@boardsesh/auth-protocol/browser-binding-v1` (nothing outside the package
imports it since the private route went; B5 deletes it with the backend core),
the `private-browser-v1` database profile, and
`CURRENT_STORE_BROWSER_BINDING_MODE`, which the startup check for staged
writers under `AUTH_CUTOFF_ENFORCEMENT=observe` still reads. One dead branch
also stays on phones: `isCancellation` in
`packages/mobile/src/lib/error-reporting.ts` still drops a
`BrowserBackendConsumerError` whose status is `superseded`, and
`packages/mobile/src/lib/__tests__/error-reporting.test.ts` keeps a stand-in
class for it.
A5 deleted the `browser-backend-consumer` module that defined the error, so
nothing throws it, but the file has no `.web` suffix and ships to phones by
OTA, so Phase A leaves it alone. B5 deletes the branch, the stand-in class and
the test case that uses it.

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
| 1. Chromium and WebKit on real HTTPS subdomains: renewal, sign-out, set-password and session reads emit no `Set-Cookie` | B1 backend tests over real HTTP for the after-hook. B7 Playwright on both engines. Rerun the fixture in [the cookie-order doc](./better-auth-browser-cookie-order.md). |
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
values of `AUTH_LEGACY_BRIDGE_MODE`, `CURRENT_STORE_BROWSER_BINDING_MODE` and
the sign-out mode ("off" comes from code defaults); whether
`/api/internal/ws-auth` sets a cookie on any path (A2 checks); and whether the
#7439 denial reader is deployed on every backend. Owner decisions 14 and 23
have no written source other than #7596.

## Related docs

[Accepted migration](./better-auth-migration.md), [cookie response
order](./better-auth-browser-cookie-order.md), [BA-01 HTTPS browser
proof](./better-auth-browser-proof.md), [legacy web credential
proof](./better-auth-legacy-web-proof.md), [first
password](./better-auth-first-password-email.md), [Expo web
deployment](./expo-web-deployment.md) ("Browser authentication") and [canonical
web origin](./web-canonical-origin.md) (cookie domain rules).
