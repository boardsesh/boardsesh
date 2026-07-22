# Cloudflare (zone config, edge caching, deploy tooling)

Everything Cloudflare for the `boardsesh.com` zone: the config-as-code tooling,
token setup, CI auto-apply, and (coming) the OpenNext deployment of the web app.

## Planned: web app on Cloudflare via OpenNext

`packages/web` is moving off Vercel onto Cloudflare Workers using OpenNext
(`@opennextjs/cloudflare`). The token + secrets below are provisioned to cover
that migration too, so the deploy job can reuse them:

- The future `deploy-web-cloudflare` workflow job reads the same
  `CLOUDFLARE_API_TOKEN` (Production environment) — no new secret setup.
- Add `CLOUDFLARE_ACCOUNT_ID` to the Production environment at the same time as
  the token (`gh secret set CLOUDFLARE_ACCOUNT_ID --env Production`); wrangler
  needs it and it never changes.

## ws.boardsesh.com edge caching (og images)

`ws.boardsesh.com` is a single-region Railway origin; distant clients (and the
iOS share sheet, which fetches previews from the sender's phone) pay full RTT
per image. Fronting it with Cloudflare edge-caches the immutable og responses
globally.

The zone config is managed from the repo — not dashboard clicks — by
`scripts/cloudflare-apply.ts` (registered as `vp run cf:apply`). The desired
state is declared in `infra/cloudflare/config.ts`; the script diffs it against
the live zone and, with `--apply`, converges only the delta (idempotent, so a
second run is a no-op).

What it manages (and nothing else on the zone):

- **DNS** — the `ws` record's proxied flag → orange cloud. The record's
  target/type/content are not managed; the record must already exist.
- **Cache** — one rule in the `http_request_cache_settings` phase, expression
  `(http.host eq "ws.boardsesh.com" and starts_with(http.request.uri.path, "/og/"))`
  → eligible for cache, edge TTL "use cache-control if present, bypass if not"
  so error responses (400/429/503 — sent without Cache-Control) are never
  edge-cached, and browser TTL "respect origin" (successful responses are `immutable`,
  1y). Every other rule already in that phase is preserved verbatim (the tool
  finds its own rule by a stable description marker and touches only that one),
  so `/graphql`, REST, and WebSocket upgrades keep bypassing cache.
- **SSL** — asserts the zone SSL/TLS mode is `strict` (Full (strict); Flexible
  causes redirect loops with Railway). If the zone-wide mode is weaker the tool
  **reports it but does not change it** — the setting affects every hostname on
  `boardsesh.com`. Pass `--allow-zone-ssl` to opt into setting it.

Code prerequisite (shipped): the og rate limiter prefers `CF-Connecting-IP`, so
per-client buckets survive the proxy hop.

### One-time: create the API token

Create ONE token covering both today's zone tooling and the upcoming OpenNext
deploy, so this setup never has to be repeated:

**Needed now (zone tooling, `vp run cf:apply`):**

Create a token at <https://dash.cloudflare.com/profile/api-tokens> scoped to the
`boardsesh.com` zone with:

- **Zone.Zone Read** — resolve the zone id by name + read the zone list
- **Zone.DNS Edit** — patch the `ws` record proxied flag
- **Zone.Cache Rules Edit** — create/update the `/og/` cache rule
- **Zone.Zone Settings Read** — read the SSL/TLS mode
- **Zone.Zone Settings Edit** — only if you'll run `--allow-zone-ssl`

**Add now for the OpenNext migration (wrangler deploy of packages/web):**

- **Account.Workers Scripts Edit** — deploy the Worker
- **Account.Workers KV Storage Edit** — OpenNext incremental cache (if KV-backed)
- **Account.Workers R2 Storage Edit** — only if the OpenNext cache uses R2
- **Zone.Workers Routes Edit** — attach the Worker to www/apex routes

Then store both values in the GitHub Production environment:

```
gh secret set CLOUDFLARE_API_TOKEN --env Production
gh secret set CLOUDFLARE_ACCOUNT_ID --env Production
```

### Flip runbook

```bash
# 1. Dry-run (default) — prints the diff, exits non-zero if there's drift. Never mutates.
CLOUDFLARE_API_TOKEN=... vp run cf:apply

# 2. Apply — performs only the needed mutations.
CLOUDFLARE_API_TOKEN=... vp run cf:apply -- --apply

# (optional) also set the zone-wide SSL mode when it's weaker than strict:
CLOUDFLARE_API_TOKEN=... vp run cf:apply -- --apply --allow-zone-ssl
```

`CLOUDFLARE_ZONE_ID` is optional — when unset, the zone id is resolved by name.

Confirm WebSockets are enabled for the zone (Network tab; on by default on
current plans). WebSocket caveat: the cache rule scopes to `/og/` only, so
`wss://ws.boardsesh.com/graphql` upgrades and every other path continue to pass
straight through to Railway.

### Verify

`wss://ws.boardsesh.com/graphql` still connects (web party mode + mobile app);
`curl -sI 'https://ws.boardsesh.com/og/climb?...'` twice — the second response
shows `cf-cache-status: HIT`.

### CI auto-apply

`production-deploy.yml` runs `vp run cf:apply -- --apply` on pushes to main
that touch `infra/cloudflare/` or the apply script (and on manual dispatch),
reading `CLOUDFLARE_API_TOKEN` from the GitHub **Production** environment
secrets: `gh secret set CLOUDFLARE_API_TOKEN --env Production`. A failing job
means unapplied drift (often a blocked zone-SSL change) — run the dry-run
locally to see the plan.

### Rollback

Set `proxied: false` on the `ws` record in `infra/cloudflare/config.ts` and
`vp run cf:apply -- --apply`, or grey-cloud the record in the dashboard.
