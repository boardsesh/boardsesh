# BA-01 HTTPS browser, CORS and server-rendering proof

This disposable proof supports [BA-01 #6976](https://github.com/boardsesh/boardsesh/issues/6976).
The [implementation ledger](./better-auth-implementation.md) owns readiness. No
production route, callback registration, cookie or credential writer changes.

## Transport and ownership

Chromium connects through real HTTPS sockets to `auth.boardsesh.test`,
`www.boardsesh.test` and `app.boardsesh.test` on an ephemeral local port. Its
resolver maps only the synthetic test domain to loopback. OpenSSL generates a
temporary wildcard certificate; the fixture deletes it during teardown. The
pinned authority uses a fresh, owned Postgres database and synthetic accounts.

The same Node fixture models both the auth edge and presentation hosts. Auth
requests use the existing backend `applyCorsHeaders` implementation, configured
for the exact website and app origins. Better Auth independently enforces its
explicit trusted-origin list. The edge model replaces client-supplied
`X-Forwarded-Host` and `X-Forwarded-Proto`; the fixed public issuer determines
discovery and redirect URLs. This tests an explicit forwarding contract, not the
deployed CDN or ingress configuration.

The presentation route forwards the incoming HttpOnly cookie to the server-side
session API and renders only the resulting public user ID. That route is
available only on the two presentation hosts. Browser JavaScript receives no
cookie value, access token or refresh token, and writes no browser storage.

## Four reproducible cases

1. Sign in over HTTPS; inspect Secure, HttpOnly, SameSite=Lax shared-domain
   cookies; complete authorization-code redirects with state and exact issuer;
   read the session on the presentation server; sign out and confirm cleanup.
2. From each website and app origin, perform an actual browser-generated JSON
   preflight and credentialed sign-in, read the auth-origin session, render it
   server-side on the presentation host, then sign out across origins.
3. From an untrusted same-site JavaScript origin, attempt a credentialed session
   read and a simple POST sign-out that requires no preflight. Browser reads are
   blocked and the existing session remains valid afterward.
4. Route RFC 8414 metadata at `/.well-known/oauth-authorization-server/api/auth`
   and OIDC metadata at `/api/auth/.well-known/openid-configuration`. Verify the
   exact issuer and token endpoint, including requests with hostile forwarding
   headers that the modeled edge replaces.

The untrusted-origin case does not prove safety against a compromised sibling
server. Shared-domain cookies are sent to every matching server, even when
HttpOnly; every host in that cookie domain must be trusted. CORS and CSRF checks
protect browser request and response boundaries, not ownership of those hosts.

## Evidence and limits

Run `vp run test:auth-prototype:browser` with an explicit local
`AUTH_PROTOTYPE_DATABASE_URL`. The task first runs the dedicated fixture
TypeScript check. Chromium must be installed using
`vp exec playwright install chromium` from `packages/web`. CI installs the
browser and required system libraries in its backend job.

The author run on 2026-11-04 passed **4/4 cases in 8.3 seconds**. Independent
review required narrowing the hostile-sibling claim and restricting the
presentation route; those changes are included. The independent final run passed
**4/4 in 8.5 seconds**, including the dedicated TypeScript check and clean lint.
After the Facebook proof exposed Better Auth's implicit test-mode origin bypass,
the shared configuration explicitly enabled both origin and CSRF checks. The
complete browser proof passed **4/4 again in 10.4 seconds** under that configuration.

This is a local Chromium integration fixture, not the product Next.js login UI
or Expo bundle. The OAuth fixture uses a managed client with consent skipped;
server tests cover consent binding separately. Safari/WebKit, actual provider
callbacks, deployed origins and forwarding, production cookie transitions,
old-cookie chunk cleanup and real devices remain release gates. The backend
CORS helper's development origin additions are not a production allowlist
audit. No passed fixture justifies switching production authentication.
