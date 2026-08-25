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

## www.boardsesh.com crawl cost controls (#4650)

Measured against production on 2026-08-25 with the Vercel MCP:

|                                    | per day          |
| ---------------------------------- | ---------------- |
| Vercel function invocations        | ~442,600         |
| — `/api/internal/board-render`     | ~215,600 (48.7%) |
| — climb view `…/view/[climb_uuid]` | ~203,900 (46.1%) |
| — `/setter/[setter_username]`      | ~15,900 (3.6%)   |
| — the other 48 routes combined     | ~7,100 (1.6%)    |
| Homepage `/`                       | ~2,000           |

Two routes are 94% of all compute, against a published sitemap of only ~60k climb
URLs and ~2,000 homepage hits. That shape is a crawl, not an audience.

> **Reading the numbers yourself:** `get_runtime_logs` with `since: 24h` is
> silently truncated — it reports 249,960 where the 6 h window × 4 gives 442,564
> and the 30 min window × 48 gives 535,632. The two short windows agree with each
> other and the 24 h one does not. Derive daily rates from a 6 h or 30 min window
> and scale, or you will under-report by ~2×.

Two more rules, managed the same way (declared in `infra/cloudflare/config.ts`,
converged by `vp run cf:apply`):

- **Board-render cache rule** — `http_request_cache_settings`, expression
  `(http.host eq "www.boardsesh.com" and starts_with(http.request.uri.path, "/api/internal/board-render"))`.
  The route already sends `cache-control: public, max-age=31536000, immutable`
  and a matching `CDN-Cache-Control`, but **Cloudflare caches by file extension
  by default** and this path has none, so it measured `cf-cache-status: DYNAMIC`
  while `/_next/static/*.js` on the same zone was a `HIT`. Every image byte was
  transiting Cloudflare to Vercel (~54 GB/day). The rule is the entire fix — no
  origin header change is needed or wanted.

- **Crawler rules** — two rules in `http_request_firewall_custom`, in this order:
  1. `skip` (all remaining custom rules) for search engines and share-card
     unfurlers. Brave runs its **own** index rather than reselling Bing or
     Google, so it is allowlisted explicitly.
  2. `block` for commercial SEO/backlink crawlers (Ahrefs, Semrush, DataForSEO,
     MJ12, DotBot, BLEXBot, Barkrowler, serpstat, Seznam, Zoominfo, Screaming
     Frog). Each was verified reaching our origin on 2026-08-24. They sell
     backlink data and send Boardsesh no traffic.

  **Order is load-bearing and enforced by the tool.** `upsertCacheRule` rewrites
  our rules as one contiguous group in declared order, because a rule-by-rule
  upsert would append a newly added allow rule _after_ an existing block rule and
  reverse their precedence. A test pins this.

  Two things the tool will not do, both deliberate:
  - It never reorders our group relative to **foreign** rules. Cloudflare's own
    AI-crawler block (which already 403s ClaudeBot, GPTBot, PerplexityBot,
    Bytespider, CCBot and friends — verified 2026-08-24) runs ahead of ours and
    stays there. That is also why those agents are absent from our block list:
    duplicating them would be dead config that drifts.
  - It never uses `cf.client.bot` as the allowlist. Ahrefs and Semrush are
    themselves Cloudflare _verified bots_, so that field is true for precisely
    the crawlers we are blocking.

`lower()` on every user-agent comparison is required, not stylistic:
Cloudflare's `contains` is case-sensitive, so a bare `contains "AhrefsBot"`
installs cleanly and matches nothing. A test pins that too.

**What this does not catch.** UA blocking only stops crawlers that identify
themselves honestly. A UA-rotating farm walked ~2,500 climb-view URLs on
2026-08-22 behind ordinary Chrome/Firefox UAs (PostHog: 2,031 distinct persons,
one pageview each, `$referring_domain` null on every event). That population
needs an edge rate-limit rule, which is not managed here yet.

### One-time: create the API token

Create ONE token covering both today's zone tooling and the upcoming OpenNext
deploy, so this setup never has to be repeated:

**Needed now (zone tooling, `vp run cf:apply`):**

Create a token at <https://dash.cloudflare.com/profile/api-tokens> scoped to the
`boardsesh.com` zone with:

- **Zone.Zone Read** — resolve the zone id by name + read the zone list
- **Zone.DNS Edit** — patch the `ws` record proxied flag
- **Zone.Cache Rules Edit** — create/update the `/og/` and board-render cache rules
- **Zone.WAF Edit** — create/update the two crawler rules (see below). Without
  this scope `cf:apply` fails on the WAF phase while the cache rules still apply,
  so a partially-converged zone is the failure mode, not a silent skip.
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

For the www rules:

```bash
# Board-render becomes cacheable: DYNAMIC -> MISS -> HIT.
B='https://www.boardsesh.com/api/internal/board-render?board_name=kilter&layout_id=1&size_id=10&set_ids=1,20&frames=p1085r15p1128r12&include_background=1'
curl -sI "$B" | grep -i cf-cache-status
curl -sI "$B" | grep -i cf-cache-status

# Blocked crawlers get a Cloudflare 403 and never reach the origin; allowed ones
# still do. `x-vercel-id` present == the request reached Vercel, which is the
# assertion that matters — a 403 alone could come from anywhere.
for UA in "AhrefsBot/7.0" "SemrushBot/7~bl" "Brave-Search/1.0" "Googlebot/2.1" "Bingbot/2.0"; do
  printf '%-18s %s ' "$UA" "$(curl -sS -o /dev/null -A "$UA" -w '%{http_code}' https://www.boardsesh.com/)"
  curl -sSI -A "$UA" https://www.boardsesh.com/ | grep -ci '^x-vercel-id' | sed 's/^/reached-vercel:/'
done
```

Expect Ahrefs and Semrush at `403 reached-vercel:0`; Brave, Google and Bing at
`200 reached-vercel:1`.

Then confirm the compute actually fell — the point of the exercise. Rerun the
route breakdown a day later and compare against the table above:

```
get_runtime_logs since=6h group_by=route source=["serverless"] environment=production
```

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
