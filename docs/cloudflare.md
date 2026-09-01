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

## assets.boardsesh.com DNS-only Tigris domain

The public static-assets hostname is repo-managed DNS. `vp run cf:apply` creates
and maintains this complete record (not just its proxy flag):

```text
assets.boardsesh.com CNAME boardsesh-static-assets.t3.tigrisbucket.io
TTL: automatic (Cloudflare API value 1)
Proxy status: DNS only
CNAME flattening: disabled
```

Keep it DNS-only. Tigris terminates TLS and serves the public objects globally;
putting Cloudflare's proxy in front would add a second CDN/TLS layer and obscure
the CNAME Tigris uses to verify the custom domain. There is deliberately no
Cloudflare cache rule for `assets.boardsesh.com`.

The apply also disables per-record CNAME flattening. It reads the zone DNS
settings and fails closed if **Flatten all CNAMEs** is enabled, because that
zone-wide option overrides the record and prevents Tigris from seeing the
literal verification target. Turn that option off in Cloudflare DNS settings;
do not bypass this guard.

One-time setup order:

1. In Tigris, create/configure the dedicated `boardsesh-static-assets` bucket,
   public reads, CORS, CI access key, and deletion protection as documented in
   [static-assets.md](./static-assets.md).
2. Register `assets.boardsesh.com` as that bucket's custom domain in Tigris.
3. Merge/apply the repo Cloudflare state. The apply creates the DNS-only CNAME
   if absent and corrects its target, type, TTL, or proxy status if they drift.
4. Wait for Tigris to report the custom domain and certificate active, then run
   the verification commands below before publishing the first catalog.

## ws.boardsesh.com edge caching (OG and board images)

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

- **DNS** — two records with different ownership boundaries:
  - `ws`: only its proxied flag → orange cloud. Its target/type/content are not
    managed and the record must already exist.
  - `assets`: the full DNS-only CNAME shape shown above. It is created when
    missing and its owned fields (including disabled CNAME flattening) are
    corrected when drifted. The tool refuses to apply while zone-wide CNAME
    flattening would override that record.
- **Cache** — two rules in the `http_request_cache_settings` phase, one for
  `(http.host eq "ws.boardsesh.com" and starts_with(http.request.uri.path, "/og/"))`
  and one for the exact board-render paths `/render/board` and
  `/api/internal/board-render` on `ws.boardsesh.com`. The compatibility path is
  still emitted by released Live Activity binaries.
  Both make successful responses eligible for cache, with edge TTL
  "use cache-control if present, bypass if not"
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

Additional policies are managed the same way (declared in
`infra/cloudflare/config.ts`, converged by `vp run cf:apply`):

- **Legacy www board-render cache rule** — `http_request_cache_settings`, expression
  `(http.host eq "www.boardsesh.com" and starts_with(http.request.uri.path, "/api/internal/board-render"))`.
  This path is retained for released ESP32 firmware, iOS Live Activities, and
  already-crawled URLs. Next.js now externally rewrites it to
  `https://ws.boardsesh.com/render/board`, so it no longer invokes a Vercel
  function. The backend sends `cache-control: public, max-age=31536000, immutable`
  and a matching `CDN-Cache-Control`, but **Cloudflare caches by file extension
  by default** and this path has none, so it measured `cf-cache-status: DYNAMIC`
  while `/_next/static/*.js` on the same zone was a `HIT`. Every image byte was
  transiting Cloudflare to Vercel (~54 GB/day). Keeping the rule protects old
  URLs and makes a Vercel Instant Rollback safe.

  Because the rule makes Cloudflare honour that year-long TTL, the URL has to
  identify the bytes it names. Every web-built board-render URL now carries a
  `&v=<12 hex>` renderer version (#4773), derived from the shipped board
  catalogue plus the compiled WASM renderer and the sharp pipeline — see
  `scripts/generate-board-render-version.ts`. A renderer change mints new URLs
  and the old ones age out; Vercel used to cover this by purging its CDN on every
  deploy (12–22×/day), and Cloudflare does not. **There is no purge tooling and
  the CI token has no `Zone.Cache Purge` scope** (see the token list below), so a
  purge is a manual dashboard action (Caching → Configuration → Purge Everything)
  if one is ever needed.

  Requests _without_ `v` — older ESP32 firmware, iOS Live Activity builds, and
  URLs Googlebot-Image crawled before this shipped (`app/robots.ts` allows the
  path) — get `s-maxage=86400, stale-while-revalidate=604800` instead of the
  one-year immutable branch. A day of staleness rather than a year, at 1/288th
  the origin cost a 300 s TTL would have carried on the route that is 48.7% of
  all function invocations.

The web emits new board-image URLs directly on `ws.boardsesh.com/render/board`.
The production workflow may apply the cache rule while the Railway deploy runs;
it promotes the web build only after both the live backend smoke and Cloudflare
apply succeed. Roll back a Railway image that lacks `/render/board` together
with the Vercel web deployment; disabling only the new Cloudflare rule is safe
but sends every image to Railway. Never disable the `ws` proxy to roll this route
back because GraphQL, WebSockets, and `/og` share that hostname.

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
one pageview each, `$referring_domain` null on every event). That population is
what the rate-limit rule below is for.

### Rate limiting the climb-view path

`http_ratelimit` is the third managed phase. One rule,
`boardsesh:climb-view-rate-limit`, counts requests per client IP against the
`/view/` path on www — the segment every climb-view URL shape shares, across the
config-tuple tree, the `/b/{slug}` tree and the `/de`, `/es` and `/fr` locale
prefixes. Matching the segment rather than enumerating the trees means the rule
cannot silently miss whichever tree is added next. The expression is host +
path only, with no header check: a `next-router-prefetch` header exclusion
shipped here once, and production apply rejected it — `not entitled: the use
of field http.request.headers.names is not allowed, an higher Advanced Rate
Limiting plan is required`. The Free plan's rate-limit expressions cannot
reference request headers at all, so Next.js router prefetches off a list
page count toward the limit the same as real page loads.

**It ships in `managed_challenge` mode.** The zone is on Free or Pro, not
Enterprise, so the softest mitigation, `log`, is rejected on apply —
Cloudflare restricts observe-only rate limiting to Enterprise. The next
gentlest action is `managed_challenge`: a real browser passes it
transparently, a headless farm mostly does not. `block` remains the blunt
instrument for later if challenge proves insufficient.

**The zone is confirmed Free plan, and the period is fixed at 10s by the
API.** The first production apply attempted `period: 60` and Cloudflare
rejected it: `not entitled to use the period 60, can only use a period among
[10]`. 10s is the only counting window Free accepts — this is not a choice,
it's a hard constraint from the API. The threshold is tuned around it: 30
requests per 10s (~180/min sustained) keeps headroom for the original
~60/min-per-IP-per-colo intent, given both the burstier 10s window and the
fact that a list-page browser's prefetch burst now counts too (the plan
won't let the expression exclude it — see above). Read a few days of
Cloudflare analytics at this setting, size the number against real traffic,
then re-tune — `requests_per_period` stays free to change; `period` does
not, and neither does the header restriction on the expression.

Two things to know:

- `mitigation_timeout` is plan-bound below Business: Free caps it at 10s, Pro
  at 60s. The rule is pinned to **10s** to match the confirmed Free plan —
  raise it to 60s only if the zone is upgraded to Pro or above.
- `cf.colo.id` is a required characteristic outside Enterprise, so the counter is
  per-datacentre rather than global and the effective allowance is higher than
  `requests_per_period` alone suggests.

Guessing low and blocking on day one throttles a gym full of climbers behind one
NAT, which is why challenge rather than block is the default. Rollback is the
usual one: set `enabled: false` on the rule and re-run
`vp run cf:apply -- --apply`.

The API token driving `cf:apply` needs `Zone.Rate Limit Edit` to create or
update this rule — see the token scope list in `scripts/cloudflare-apply.ts`
and the token section below. Without that scope, `deploy-cloudflare` 403s
specifically on the `http_ratelimit` phase while every other phase applies
cleanly.

### One-time: create the API token

Create ONE token covering today's zone tooling, the Pages deploy of
`app.boardsesh.com`, and the upcoming OpenNext deploy, so this setup never has to
be repeated.

> **One token, three consumers.** `CLOUDFLARE_API_TOKEN` in the GitHub Production
> environment is read by `deploy-cloudflare` (zone config), `deploy-app-web`
> (`wrangler pages deploy`), and later the OpenNext web deploy. **Rotating or
> re-scoping it for one of them silently breaks the others** — a token carrying
> only the zone scopes below authenticates fine against the zone and returns
> `Authentication error [code: 10000]` on `/pages/projects/boardsesh-app`. That
> exact regression took `app.boardsesh.com` off the deploy train on 2026-08-25.
> Grant every section below, not just the one you came here for.

**Needed now (zone tooling, `vp run cf:apply`):**

Create a token at <https://dash.cloudflare.com/profile/api-tokens> scoped to the
`boardsesh.com` zone with:

- **Zone.Zone Read** — resolve the zone id by name + read the zone list
- **Zone.DNS Edit** — patch the `ws` proxy flag, create/update the `assets` CNAME,
  and read the zone's CNAME-flattening settings
- **Zone.Cache Rules Edit** — create/update the `/og/` and board-render cache rules
- **Zone.WAF Edit** — create/update the two crawler rules (see below). Without
  this scope `cf:apply` fails on the WAF phase while the cache rules still apply,
  so a partially-converged zone is the failure mode, not a silent skip.
- **Zone.Rate Limit Edit** — create/update the climb-view rate-limit rule in the
  `http_ratelimit` phase. Same partial-convergence failure mode as WAF Edit: the
  earlier phases apply, this one 403s.
- **Zone.Zone Settings Read** — read the SSL/TLS mode
- **Zone.Zone Settings Edit** — only if you'll run `--allow-zone-ssl`

**Needed now (Pages deploy of app.boardsesh.com, `deploy-app-web`):**

- **Account.Cloudflare Pages Edit** — `wrangler pages deploy` against the
  `boardsesh-app` project. Account-scoped, so the token cannot be zone-only.
  Without it the publish step fails with `Authentication error [code: 10000]`
  while `wrangler whoami` still succeeds — it reads as a bad token, but it is a
  missing scope.

  **The permission picker is grouped by resource type, and Cloudflare Pages
  exists only in the Account group** — never in the Zone/domain group where every
  other scope on this token lives. Browsing the domain section for it is a dead
  end: what surfaces there is `Custom Pages` (branded error pages), `Page Shield`
  and `Page Rules`, none of which is Cloudflare Pages. That is what cost four
  attempts in 2026-08. Set the row's left-hand dropdown to **Account** first,
  then pick it, and name the account under **Account Resources**.

  Verify by reading the token back rather than by eye — the dashboard renders all
  three resource forms similarly, and only the first grants Pages:

  ```jsonc
  { "com.cloudflare.api.account.<id>": "*" }                                           // account — Pages attaches here
  { "com.cloudflare.api.account.<id>": { "com.cloudflare.api.account.zone.*": "*" } }  // all zones — it does NOT
  { "com.cloudflare.api.account.zone.<id>": "*" }                                      // one zone — it does NOT
  ```

  Read it from `GET /accounts/{account_id}/tokens/{id}` for an account-owned
  token (dashboard → account → API tokens) or `GET /user/tokens/{id}` for a user
  token (`/profile/api-tokens`). Those are two separate token systems with
  separate lists; ours is account-owned, which `wrangler whoami` confirms by
  printing `You are logged in with an Account API Token`.

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

That one apply covers both DNS records plus the cache/WAF phases. A missing
`ws` record remains a hard error because this repo does not know its origin
target; a missing `assets` record is an ordinary planned create.

`CLOUDFLARE_ZONE_ID` is optional — when unset, the zone id is resolved by name.

Confirm WebSockets are enabled for the zone (Network tab; on by default on
current plans). The cache rules scope to `/og/`, `/render/board`, and the exact
Live Activity compatibility path `/api/internal/board-render`, so
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

# The versioned URL is the one the site actually emits, and the only one that
# gets the immutable branch. Use the current constant from
# packages/shared/board-render/src/generated/render-version.ts.
V=$(sed -n "s/.*BOARD_RENDER_VERSION = '\(.*\)';/\1/p" packages/shared/board-render/src/generated/render-version.ts)
curl -sI "$B&v=$V" | grep -iE 'cache-control|cf-cache-status'   # immutable; MISS then HIT
curl -sI "$B"      | grep -iE 'cache-control|cf-cache-status'   # s-maxage=86400 + SWR

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

For the static-assets custom domain, confirm the public DNS answer remains the
Tigris target (not Cloudflare anycast), TLS is valid, listing is unavailable,
and a catalog object supports both `HEAD` and cross-origin `GET`:

```bash
dig +short assets.boardsesh.com CNAME
curl -sS -o /dev/null -w '%{http_code}\n' https://assets.boardsesh.com/
curl -sSI -H 'Origin: https://www.boardsesh.com' \
  https://assets.boardsesh.com/static/v1/<catalog-object>
curl -sS -H 'Origin: https://www.boardsesh.com' -o /dev/null -D - \
  https://assets.boardsesh.com/static/v1/<catalog-object>
```

The CNAME must be `boardsesh-static-assets.t3.tigrisbucket.io.` and the bucket
root should return `403` rather than an object listing. The object
responses must include the image's correct content type,
`cache-control: public, max-age=31536000, immutable`, and a permissive CORS
header.

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
means unapplied drift — run the dry-run locally to see the plan.
The assets DNS record is included in the same job; no dashboard DNS step is
needed after the Tigris-side custom domain registration.

A **blocked** zone-SSL change is the one failure a merge cannot clear: pushes
deliberately resolve `--allow-zone-ssl` to empty, so `cf:apply` re-plans the same
change, skips it, and exits non-zero on every subsequent push. Clear it once, by
hand — either `Actions → Production Deploy → Run workflow` with
**cloudflare_allow_zone_ssl** ticked, or by setting the mode in the dashboard.
Before flipping the zone, check that every **proxied** hostname's origin serves a
publicly-trusted cert for its exact name, since the mode is zone-wide:

```bash
# Proxied hosts resolve to Cloudflare IPs (104.21.x / 172.67.x); DNS-only hosts
# resolve straight to the origin and the zone SSL mode does not govern them.
for H in www ws updates app; do
  echo "$H: $(dig +short "$H.boardsesh.com" A | tr '\n' ' ')"
done

# For each proxied host, ask its origin for the cert it would show Cloudflare.
# Railway's edge selects the cert by SNI, so any Railway hostname reaches the
# right one — the app name below is not load-bearing, `-servername` is.
openssl s_client -connect backend-production.up.railway.app:443 \
  -servername ws.boardsesh.com </dev/null 2>/dev/null |
  openssl x509 -noout -subject -issuer -dates

# Vercel-backed hosts answer on their CNAME target the same way.
openssl s_client -connect cname.vercel-dns.com:443 \
  -servername www.boardsesh.com </dev/null 2>/dev/null |
  openssl x509 -noout -subject -issuer -dates
```

`updates.boardsesh.com` is Railway too, so it takes the first form with its own
`-servername`. `app.boardsesh.com` is Pages — the origin is Cloudflare itself, so
there is nothing to check.

Measured 2026-08-25: `www` (Vercel), `ws` and `updates` (Railway) are the only
proxied origins and each serves a Let's Encrypt cert for its exact hostname, so
`strict` is safe. The apex and `ota.boardsesh.com` are DNS-only and unaffected;
`*.preview.boardsesh.com` rides a Cloudflare Tunnel, which does not use the
zone's origin-encryption mode.

### Rollback

For a bad board-render cache rule, set the matching rule's `enabled` field to
`false` in `infra/cloudflare/config.ts` and run `vp run cf:apply -- --apply`.
For a bad renderer deployment, roll back the web and Railway releases together;
the compatibility path remains routed to Railway. Grey-cloud `ws` only for a
Cloudflare proxy incident, because doing so removes edge caching from both image
endpoints and sends their full load directly to Railway.
