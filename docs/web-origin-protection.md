# Web origin protection

The Railway-generated web hostname is required by deployment identity checks,
but crawlers have used it to bypass Cloudflare. The web middleware can require
`X-Boardsesh-Origin-Verify` before any rendering, routing or API handling.
Cloudflare overwrites that request header for `www.boardsesh.com`. It does not
add the secret to responses. Browser clients never need to know the secret.

`WEB_ORIGIN_VERIFY_ENABLED=1` activates the guard. Missing or short secrets then
fail closed. With the flag absent, the middleware only strips the header, so the
preparation deployment does not interrupt existing traffic. Preview and local
services leave the flag unset. The only unauthenticated production exception is
GET/HEAD on the exact `/api/health` route used by Railway health probes.

The guard covers API routes, dotted paths, Next assets and image optimization,
well-known files, and monitoring routes. Locale/session/CORS handling retains its
previous narrower scope. The verification header is removed before forwarding,
including Next external rewrites. Existing user authorization and POST bodies
remain intact. Server and edge Sentry hooks also strip the incoming header from
errors, transactions, span attributes and structured-log attributes, because
Sentry can capture headers before middleware runs. A rejected request gets an empty, non-cacheable 403.

## Deployment order

1. Merge/deploy the middleware and CI support with the activation flag unset.
   Verify the existing direct-origin smoke remains green.
2. Generate 32 random bytes as 64 lowercase hex characters in a secret manager.
   Set the same `WEB_ORIGIN_VERIFY_SECRET` on the Railway web service and in
   the GitHub **Production** environment. Keep it out of public/build variables,
   shell arguments, logs, artifacts and PR text.
3. Run **Cloudflare origin protection** with `apply=false`, then `apply=true`.
   It manages only the www request-header rule, preserves other rules, rejects
   conflicting ownership and verifies its write. The token needs zone transform
   rules edit access. No credential or rule-body diff is printed.
4. Verify www still renders, including with a deliberately incorrect incoming
   header: Cloudflare must overwrite it. Verify the direct Railway smoke with
   the GitHub secret. A unit test also prevents cross-origin redirect leakage.
5. Set `WEB_ORIGIN_VERIFY_ENABLED=1` on the Railway **web** service and allow its
   rolling redeploy. Run the authenticated direct-origin smoke again. Verify
   unauthenticated direct page/API/asset requests return 403, `/api/health`
   remains 200, and www, traditional search and share previews still work.
6. Confirm direct-origin crawler requests stop rendering. Compare public backend
   egress and web CPU against the cost baseline after a full day.

Steps 2–5 require the preparation deployment to be live; do not inject the header
into the old deployment, which does not yet strip it before external rewrites.
The workflow is manual so a routine zone-config change cannot prematurely
activate or rotate the secret. CI's normal and rollback web smokes both use it.

Cloudflare's [request header transform API](https://developers.cloudflare.com/rules/transform/request-header-modification/create-api/)
uses `http_request_late_transform` with a `set` operation to replace a supplied
header. The managed rule is scoped to www; the apex redirect and backend domains
are not web origins. The direct Railway domain remains available to CI.

## Rollback and rotation

For an outage, first unset `WEB_ORIGIN_VERIFY_ENABLED` on the web service and
redeploy. Verify www and direct-origin smoke before changing Cloudflare. Keep the
stripping middleware deployed while the edge still sends a secret.

For rotation, disable enforcement first, rotate both stored copies, apply the
Cloudflare rule, verify authenticated smoke, then re-enable. A zero-downtime
rotation with overlapping secrets is not implemented. Reverting to a pre-guard
image requires removing the Cloudflare header rule first; disabling the flag alone
retains stripping on the new image. Never publish the secret to help diagnose a
403; check only presence, matching configuration and sanitized status results.

## Current rollout state

This PR prepares protection; enforcement is not active until the deployment order
above is completed. The crawler-policy PR is independent and reduces identified
AI traffic while origin protection closes the direct-host bypass for other UAs.
