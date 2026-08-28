# The web app's canonical origin (and why a missing one logs everyone out)

Every hosted deployment of `packages/web` **must** be told which origin it serves.
This is the one environment variable you cannot forget.

## What to set

| Variable       | Required         | What it does                                                                                                                                        |
| -------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NEXTAUTH_URL` | Yes, on any host | The canonical origin. next-auth builds every auth URL (including the OAuth `redirect_uri`) from it, and `sessionCookieDomain()` reads its hostname. |
| `BASE_URL`     | Yes, same value  | Fallback for the above, and the base for links in verification / password-reset email.                                                              |

Both should be the exact public https origin, no trailing slash: `https://www.boardsesh.com`.

`AUTH_COOKIE_DOMAIN` overrides the derived cookie domain for a non-standard deployment.
You almost never want it.

## What happens without one

`packages/web/app/lib/auth/secure-cookies.ts` picks the session cookie name from
whether this is a secure context, and the cookie's `Domain` from the serving
hostname. With no canonical origin:

- the session cookie is written as `next-auth.session-token`, not `__Secure-next-auth.session-token`;
- it loses `Domain=.boardsesh.com`, so it stops being shared with `app.boardsesh.com`;
- a cookie of the same name at a different domain scope is a **different browser
  entry**, so even holding the name fixed this is its own logout;
- next-auth falls back to `http://localhost:3000` and Google/Apple sign-in sends
  people to a dead localhost page (this actually shipped once — issue #4227).

Cookie name and domain are how a browser finds an existing session. Change either
and every signed-in user is logged out at once.

## The boot guard

`diagnoseCanonicalOrigin()` (`packages/web/app/lib/auth/canonical-auth-url.ts`)
runs from `instrumentation.ts` on every server boot:

| Runtime                                                      | Result                                        |
| ------------------------------------------------------------ | --------------------------------------------- |
| `NODE_ENV=production`, neither `NEXTAUTH_URL` nor `BASE_URL` | **fatal** — logs the reason and exits `1`     |
| `NODE_ENV=production`, only a loopback origin named          | warning — correct for `next start` and CI e2e |
| anything else (dev, vitest, a build)                         | silent                                        |

It exits rather than throws. Throwing out of `register()` leaves Next listening
and answering every request with a 500 while a TCP healthcheck still reports
`healthy` — measured on this image. Exiting is the signal a deploy fails on.

`AUTH_ALLOW_MISSING_CANONICAL_ORIGIN=1` downgrades the fatal to a warning and lets
the server boot. **It does not fix anything** — it boots straight into the
logged-out state above. Emergency use only, when a degraded site genuinely beats
no site.

## Why this bit us

`Dockerfile.web` declared `ARG BASE_URL` / `ENV BASE_URL` in the **builder** stage
only. Next's standalone writer copies just `.env` and `.env.production` into the
output — never the tracked `packages/web/.env.local` that supplies these values on
a laptop and on Vercel. So the runtime container had no canonical origin at all,
and the old backstop in `applyCanonicalAuthUrl()` needed a _parseable loopback_
`NEXTAUTH_URL` before it would say anything, so an absent one produced no warning
whatsoever. Issue #4651.

The runner stage now declares `ARG`/`ENV BASE_URL` of its own. Prefer supplying
both variables at run time anyway (Railway service variables, `docker run -e`);
the build arg is only a baked default for an image built for one known origin,
which is how `.github/workflows/branch-deploy.yml` builds preview images.

Two consequences worth knowing:

- With no `--build-arg BASE_URL`, that `ENV` bakes the **empty string**, so
  `BASE_URL` is present-and-empty rather than absent. Anything reading it must
  treat empty as unset — `?.trim() ||`, never `??`. The transactional-email
  routes (`register`, `forgot-password`, `resend-verification`) do.
- Running the standalone server straight out of a local `vp run build`
  (`node packages/web/.next/standalone/packages/web/server.js`) now exits `1`:
  that tree has no `.env` files at all, for the same reason the container didn't.
  Pass `NEXTAUTH_URL=http://localhost:3000` on the command line.

## Verifying a deployment

```sh
curl -sS -D- -o /dev/null https://<host>/api/auth/csrf | grep -i '^set-cookie'
```

On the production www host you want, exactly:

```
set-cookie: __Host-next-auth.csrf-token=…; Path=/; HttpOnly; Secure; SameSite=Lax
set-cookie: __Secure-next-auth.callback-url=…; Domain=.boardsesh.com; Path=/; HttpOnly; Secure; SameSite=None
```

Both prefixes and the `Domain` come from the same `cookies` block that names the
session cookie (`packages/web/app/lib/auth/auth-options.ts`), so this one request
is a sufficient check — no login required.

A preview host (`{N}.preview.boardsesh.com`, `*.vercel.app`) should show the
`__Secure-` prefix but **no** `Domain`: a preview must never be able to write or
delete the production cookie identity.
