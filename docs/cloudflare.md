# Cloudflare (zone config, edge caching, deploy tooling)

Everything Cloudflare for the `boardsesh.com` zone: the config-as-code tooling,
token setup, CI auto-apply, and the Pages deploy of `app.boardsesh.com`.


## R2 buckets

`infra/cloudflare/config.ts` declares the R2 buckets alongside the zone, and `vp run cf:apply` converges them: it creates a declared bucket that is missing and attaches its custom domain. See `docs/user-media-storage.md` for what lives in each one.

**`customDomain` is the whole access-control story.** R2 implements no object ACLs and no bucket policies, so there is no way to make one prefix of a bucket private — attaching a custom domain publishes every object in it. `boardsesh-user-private` holds user data exports and is declared `customDomain: null`; if it is ever found serving a domain, the apply reports it `BLOCKED` and stops rather than detaching it on its own. Buckets are created when absent and never deleted by this tool.

### Token scopes

R2 is **account**-scoped, unlike everything else here, so managing it needs two things the zone work does not:

- `CLOUDFLARE_ACCOUNT_ID` in the environment. Without it, R2 is skipped with a notice.
- `Account.Workers R2 Storage:Edit` on `CLOUDFLARE_API_TOKEN`. Without it, the R2 read fails authorization and is skipped with a warning — the zone config still applies.

Both degrade to "skip and say so" rather than failing, so the secret and the scope can be added in either order without a window where production deploys break. Attaching a custom domain needs **both** the R2 scope and zone access, because the call takes a `zoneId`: an R2-only token can create the bucket but cannot resolve the zone.

> **Editing the token replaces ALL of its policies.** Re-add every existing scope in the same edit — the `Zone.*` list above and `Account.Cloudflare Pages Edit`. A rotation that granted only the zone scopes is what took `app.boardsesh.com` off the deploy train on 2026-08-25, and it presents as `Authentication error [code: 10000]` while `wrangler whoami` still succeeds.

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

## www.boardsesh.com DNS, and the origin flip

`www.boardsesh.com` is a proxied CNAME to the Railway `boardsesh-web` service
(#4655, epic #4648), fully managed by the repo:

```ts
{
  management: 'full',
  name: WWW_HOSTNAME,
  type: 'CNAME',
  content: 'nefrfe3c.up.railway.app',
  ttl: 1,
  proxied: true,
}
```

It started life as `management: 'proxied-only'` — same boundary as `ws`, target
left to the dashboard. A proxied record answers with Cloudflare anycast
addresses, so that target was not readable from outside the dashboard (`dig`
included); that was the point — it let this entry land as a reviewable no-op
before the flip PR took ownership of `type`/`content`/`ttl` too and PATCHed the
record from the Vercel CNAME onto the Railway target above.

### Flipping www to a new origin

This is the general playbook for pointing www at a new origin. #4655
(2026-09-01) exercised it once, moving www from Vercel to Railway; follow the
same steps for any future origin change.

The flip is step 3 of the cut-over sequence in
[production-deploy.md](./production-deploy.md#cut-over-sequence): only after
`WEB_DEPLOY_TARGETS=vercel,railway` is shipping both, and the post-deploy smoke
has passed against `RAILWAY_WEB_ORIGIN`.

1. In Railway, add `www.boardsesh.com` as a custom domain on the `web` service.
   Railway prints the CNAME target to point at — a per-service hostname like
   `<something>.up.railway.app`. That printed value is the only source of truth
   for it; it is not derivable from the service name.
2. Change the one entry in `infra/cloudflare/config.ts` to take ownership of the
   target:

   ```ts
   {
     management: 'full',
     name: WWW_HOSTNAME,
     type: 'CNAME',
     content: '<the target Railway printed in step 1>',
     ttl: 1,
     proxied: true,
   }
   ```

   No `settings` block. Cloudflare always flattens a **proxied** CNAME (the
   public answer is its own anycast address), so `flatten_cname` is not a field
   we own on this record — unlike the DNS-only `assets` CNAME, where the literal
   answer has to stay visible for Tigris to verify it. For the same reason the
   zone-wide "Flatten all CNAMEs" guard does not apply to www; a test pins that.

3. Update the two places in `scripts/cloudflare-apply.test.ts` that pin today's
   state: the shape assertion in `www.boardsesh.com under Cloudflare management`,
   and `liveWwwDnsRecord()`'s `content` (it stands in for the live record, so it
   becomes the Railway target). Nothing else needs touching — the tests fail
   loudly if you miss one.
4. Merge. `deploy-cloudflare` PATCHes the record on the way through. Traffic
   moves as Cloudflare's edge picks up the new origin — there is no public TTL
   to wait out, because the record is proxied and the public answer never
   changes.

**Rollback is `git revert` of that PR.** Reverting restores the Vercel target in
`content` and the next apply PATCHes it straight back. Vercel keeps deploying
every commit through the seven-day dual window, so the rollback origin is warm;
after the scrub step decommissions the Vercel project, this rollback is gone and
the fix is forward-only.

Zone SSL is already `strict`, so nothing about the flip is held back by the
SSL gate — but the Railway `web` service must serve a publicly-trusted cert for
`www.boardsesh.com` before the flip, exactly as `ws` does. Check it with the
`openssl s_client -servername` recipe in [CI auto-apply](#ci-auto-apply).

## boardsesh.com (the apex) → www

The apex is repo-managed and **originless**: it exists only so Cloudflare
terminates the request and answers it with a redirect.

```text
boardsesh.com A 192.0.2.0
TTL: automatic (Cloudflare API value 1)
Proxy status: Proxied  ← load-bearing
```

`192.0.2.0` is one of the two reserved addresses Cloudflare documents for a
proxied record with no origin behind it (the other is `100::`, an AAAA). It is
RFC 5737 TEST-NET-1, reserved for documentation and guaranteed never to be
routed, so a packet that somehow escaped the proxy goes nowhere real — which is
not true of an address picked at random.

**The A form is deliberate, and it is not about IP version.** The apex already
exists as a DNS-only `A` record to Vercel (`76.76.21.21`), so declaring an `A`
makes the apply an in-place update of that record: content and the proxied flag,
nothing else. Declaring the `AAAA` placeholder instead would make the apply
change the record's *type*, which either lands a second record beside the A —
split-brain, where some resolvers reach Vercel unproxied while others reach
Cloudflare — or depends on the API accepting a type change in place. Neither is
something to discover during a production apply.

**Never grey-cloud this record.** DNS-only, the apex resolves to an unroutable
address with nothing in front of it and boardsesh.com goes dark.

If the apex ever ends up holding **both** an A and an AAAA record, the apply
**fails loudly before it mutates anything**: the live-state read refuses to pick
one of two address records at the same name, and it runs before any write. Fix
the duplicate in the dashboard, then re-run.

The redirect itself is one rule in the `http_request_dynamic_redirect` phase
(Cloudflare calls these Single Redirects, or Redirect Rules in the dashboard):

| Field                  | Value                                                     |
| ---------------------- | --------------------------------------------------------- |
| Description marker     | `boardsesh:apex-to-www`                                    |
| Expression             | `http.host eq "boardsesh.com"`                             |
| Action                 | `redirect`, status `301`                                   |
| Target URL (dynamic)   | `concat("https://www.boardsesh.com", http.request.uri.path)` |
| Preserve query string  | on                                                         |

`preserve_query_string` is what carries `?a=1`, so the expression only rebuilds
the path — the simplest shape that keeps both. It is also the only shape
available: Cloudflare's rules language has no ternary operator, so assembling
the query string inside the expression is not possible. `target_url` is either
`{ value }` for a fixed destination or `{ expression }` for a computed one; a
rule carrying both is rejected.

`http.host` is the request's Host header, so the rule matches the apex and
nothing else on the zone — `www`, `ws`, `assets`, `app` and `updates` all keep
serving themselves.

**Once this applies, Vercel is out of the apex path.** The apex used to be a
DNS-only `A` record to `76.76.21.21` and Vercel served the apex → www 308. The
record now points at Cloudflare, so the redirect is answered at the edge, it is
a 301 rather than a 308, and it keeps working after the Vercel project is
decommissioned in the scrub step of the cut-over.

Verify after the merge:

```bash
curl -sI 'https://boardsesh.com/kilter/8/25/15,17/40/view/abc?utm_source=x' |
  grep -iE '^(HTTP|location|cf-ray)'
```

Expect `HTTP/2 301`, a `location:` of
`https://www.boardsesh.com/kilter/8/25/15,17/40/view/abc?utm_source=x`, and a
`cf-ray` header (which is what proves Cloudflare answered rather than an origin).

**If the token lacks `Zone.Dynamic Redirect Edit`,** `deploy-cloudflare` 403s on
this phase and this phase only. The cache, WAF and rate-limit phases apply
normally, so the failure mode is a half-converged zone: the apex record flips to
the originless address while nothing is there to redirect it, and the apex
serves Cloudflare's error page until the scope is added and the job re-run.
**Add the scope before merging.** If it happens anyway, add the scope and re-run
`Actions → Production Deploy → Run workflow`, or roll back by reverting the
commit (which restores the Vercel `A` record on the next apply).

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

- **DNS** — records with different ownership boundaries:
  - `ws` and `www`: only the proxied flag → orange cloud. Their target/type/content
    are not managed and the records must already exist.
  - `assets`: the full DNS-only CNAME shape shown above. It is created when
    missing and its owned fields (including disabled CNAME flattening) are
    corrected when drifted. The tool refuses to apply while zone-wide CNAME
    flattening would override that record.
  - the apex `boardsesh.com`: the full proxied, originless `A 192.0.2.0` shape
    shown above, so the redirect rule can answer it.

  The lookup is by name, and Cloudflare's list endpoint returns every record type
  at that name. Only `A`, `AAAA` and `CNAME` are considered, so the MX, TXT and
  CAA records a hostname (especially the apex) carries alongside its address
  record do not make it look ambiguous. Two _address_ records at one name still
  fail closed: that is a real conflict and the tool must not pick one.
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
- **Redirect** — one rule in the `http_request_dynamic_redirect` phase sending
  the apex to www with a 301, path and query preserved. Foreign rules in that
  phase are preserved verbatim, same as every other phase.
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

### Caching list and climb-view HTML (#4652)

`packages/web/middleware.ts` has decorated list pages and climb-view pages with
`CDN-Cache-Control: s-maxage=86400, stale-while-revalidate=604800` since long
before www moved to Railway (TTLs from `app/lib/list-page-cache.ts`). Those
headers were **inert**: Cloudflare had no cache rule for www HTML, and it caches
by file extension by default, which a page route does not have. Measured against
production on 2026-09-02, a logged-out list page returned the header and
`cf-cache-status: DYNAMIC` — so every crawler hit re-rendered at the single
`us-west2` Railway replica against Postgres. The fourth cache rule,
`boardsesh:www-html-edge-cache`, is what makes the origin's own TTL take effect.

Same action as the other three: eligible for cache, edge TTL
`bypass_by_default`, browser TTL `respect_origin`. `bypass_by_default` is the
safety model, not a detail — the origin decides, and anything it does not
decorate stays out of the edge. A list page carrying a user-specific filter
(`?onlyDrafts=true`, `?minUserRating=4`) was measured returning
`Cache-Control: private, no-cache, no-store` and **no** `CDN-Cache-Control`, so
the expression never has to enumerate `USER_SPECIFIC_SEARCH_PARAMS`. The
sticky-locale 307 (`/kilter/…` → `/es/kilter/…` for a visitor carrying
`boardsesh-locale`) returns before the middleware's cache-header block and
carries no cache directive at all, so it bypasses too. **Never switch this rule
to `override_origin`:** it ignores the origin *and* strips `Set-Cookie` in order
to cache.

The expression carries three explicit bypasses on top of the host and path
gates. All three exist because **Cloudflare honours `Vary` only for
`Accept-Encoding` below Enterprise** and these responses ship
`Vary: rsc, next-router-state-tree, next-router-prefetch,
next-router-segment-prefetch, Accept-Encoding`.

1. **The session cookie.** `not (http.cookie contains "next-auth.session-token")`.
   The origin does not help here: a request carrying a session cookie was
   measured still getting `CDN-Cache-Control: s-maxage=86400`. One substring
   covers `__Secure-next-auth.session-token` (production), the bare
   `next-auth.session-token` (which the read path still honours — see
   `sessionCookieNameCandidates`), and the `<name>.0`, `<name>.1` chunks
   next-auth splits an oversized session into.
2. **The RSC header.** `not (any(http.request.headers["rsc"][*] != ""))`. This
   is the one that would have hurt. `RSC: 1` on a list page returns a **307 to
   `?_rsc`** carrying `CDN-Cache-Control: s-maxage=86400` and no
   `Cache-Control` — a redirect the edge would store under the *same cache key
   as the HTML document* and serve to real browsers for 24 hours. Anyone can
   send that header. `list-page-cache.ts` already carries the #4592 warning that
   a cacheable redirect loop at this TTL pins for a full day. Bypassing on any
   non-empty value rather than on `== "1"` (the only value Next acts on today)
   keeps a Next.js change from reopening it.
3. **`?_rsc`.** `not (http.request.uri.query contains "_rsc")`, the redirect's
   own target and the shape Next's router actually fetches.

Two things about that second clause:

- It reads the header through the documented map accessor
  `http.request.headers["rsc"]`, **not** `http.request.headers.names` — the
  field production rejected in the `http_ratelimit` phase with `not entitled:
  the use of field http.request.headers.names is not allowed, an higher
  Advanced Rate Limiting plan is required`. That entitlement is rate-limiting
  specific (Advanced Rate Limiting is a rate-limiting SKU); it is not a
  zone-wide ban on header fields. Cloudflare's cache-rule docs list
  **Request Headers — `http.request.headers`** among the fields a cache rule
  expression may use, and Cloudflare's field catalogue tags 70 of its 173
  fields with a `plan_info_label` (`http.request.body.raw` → `Enterprise`) while
  tagging `http.request.headers` and `http.cookie` with none. **This has not
  been proven against the live zone** — nobody has applied it yet.
- If Cloudflare *does* reject it, the failure is safe: the `http_request_cache_settings`
  PUT 400s, no rule is created, and www HTML keeps behaving exactly as it does
  today. `deploy-cloudflare` goes red and the fix is a deliberate one. The
  dangerous state — a rule that caches HTML *without* the RSC bypass — cannot
  be reached by that failure, only by someone deleting the clause.

The path gate is the full {locale prefix} × {board tree root} cross product
(4 × 9 = 36 `starts_with` clauses, 2,187 of the 4,096 characters a rule
expression may hold), because the middleware tests the first segment of the
**locale-stripped** path and Cloudflare cannot strip a prefix. A test reads
`SUPPORTED_BOARDS` and `SUPPORTED_LOCALES` from their real source files and
fails if either list grows without this one; another fails at 3,072 characters,
so the cross product's growth gets compacted deliberately rather than
discovered as a 400 during a production apply.

**Known behaviour change: `/es`, `/fr` and `/de` pages stop handing out the
sticky-locale cookie once they are served from cache.** The middleware sets
`boardsesh-locale` on every non-default-locale response for a non-crawler, and
Cloudflare does not cache a response carrying `Set-Cookie` under
`bypass_by_default`. Crawlers never receive that cookie, so their responses are
the ones that populate the edge — and a human landing on a cached `/es` page
gets no cookie. Navigation within `/es` is locale-prefixed anyway
(`LocaleLink`), so this only affects a later unprefixed entry point.

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

**It ships in `block` mode, because that is the only rate-limit action the
Free plan allows.** Every gentler option was rejected at apply time: `log` is
Enterprise-only, and `managed_challenge` came back as `not entitled to use the
managed_challenge action in ratelimiting` (run 33476545859). A client that
trips the rule loses `/view/` paths for the 10 s mitigation window and is then
counted afresh — so the threshold is deliberately generous (below).

**The zone is confirmed Free plan, and the period is fixed at 10s by the
API.** The first production apply attempted `period: 60` and Cloudflare
rejected it: `not entitled to use the period 60, can only use a period among
[10]`. 10s is the only counting window Free accepts — this is not a choice,
it's a hard constraint from the API. The threshold is tuned around it and
around the fact that the action is a block: 60 requests per 10s per IP per
colo (~360/min sustained) trips on a single-address bulk crawler sustaining
6 req/s, while a gym behind one NAT would need 60 climb-page loads inside 10s
— prefetch bursts included, since the plan won't let the expression exclude
them (see above) — to be blocked, and then only for 10s. Read a few days of
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
NAT, which is why the threshold is generous rather than tight. Rollback is the
usual one: set `enabled: false` on the rule and re-run
`vp run cf:apply -- --apply`.

The API token driving `cf:apply` needs `Zone.Rate Limit Edit` to create or
update this rule — see the token scope list in `scripts/cloudflare-apply.ts`
and the token section below. Without that scope, `deploy-cloudflare` 403s
specifically on the `http_ratelimit` phase while every other phase applies
cleanly.

### One-time: create the API token

Create ONE token covering today's zone tooling and the Pages deploy of
`app.boardsesh.com`, so this setup never has to be repeated.

> **One token, two consumers.** `CLOUDFLARE_API_TOKEN` in the GitHub Production
> environment is read by `deploy-cloudflare` (zone config) and `deploy-app-web`
> (`wrangler pages deploy`). **Rotating or re-scoping it for one of them silently
> breaks the other** — a token carrying
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
- **Zone.Dynamic Redirect Edit** — create/update the apex → www redirect in the
  `http_request_dynamic_redirect` phase. Same partial-convergence failure mode,
  and worse in effect: the apex DNS record flips to the originless address while
  no rule exists to answer it. In the permission picker the row is called
  **Dynamic Redirect**, not "Redirect Rules" or "Single Redirects".
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

Then store both values in the GitHub Production environment:

```
gh secret set CLOUDFLARE_API_TOKEN --env Production
gh secret set CLOUDFLARE_ACCOUNT_ID --env Production
```

### Flip runbook

> **Railway origins:** before flipping any hostname to a `*.up.railway.app` target, add Railway's `_railway-verify.<host>` ownership TXT (dashboard-only value) and wait for the domain to show `verified: true` — see docs/production-deploy.md, "Railway custom-domain verification".

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

#### After the www HTML cache rule applies (#4652)

Run these in order. Step 4 is the one that matters: a cached RSC redirect is the
failure this rule was designed around, and it is invisible until a browser hits
it. Use `-o /dev/null -D -` (a GET) rather than `-I` — a HEAD is a different
cache entry.

```bash
L='https://www.boardsesh.com/kilter/homewall/7x10-full-ride/main_aux/40/list'
show() { curl -s -o /dev/null -D - "$@" | grep -iE '^(HTTP|cf-cache-status|age|location|cdn-cache-control|set-cookie)'; }

# 1. Anonymous list page: DYNAMIC before the rule, MISS then HIT after it.
show "$L"
show "$L"

# 2. Same for a climb view, and for a locale twin. Pick a real climb URL from
#    https://www.boardsesh.com/sitemap.xml.
show 'https://www.boardsesh.com/b/<board-slug>/40/view/<climb-uuid>'

# 3. Signed in: BYPASS, every time. Paste a real session cookie from a logged-in
#    browser (DevTools -> Application -> Cookies).
show -H 'Cookie: __Secure-next-auth.session-token=<paste>' "$L"

# 4. THE ONE THAT MATTERS. The RSC request must stay uncached, and — critically —
#    must not have poisoned the entry for everyone else.
show -H 'RSC: 1' "$L"          # expect: 307, location .../list?_rsc, cf-cache-status BYPASS
show "$L"                      # expect: STILL 200 HTML. A 307 here means the rule is broken.
show "$L?_rsc"                 # expect: BYPASS

# 5. A user-specific filter must never share the anonymous entry.
show "$L?onlyDrafts=true"      # expect: no cdn-cache-control, cf-cache-status BYPASS
```

Expected: step 1's second call is `HIT` with a growing `age`; step 3 and steps
4–5 are all `BYPASS`; step 4's middle call is a 200 HTML document, not a
redirect. **If step 4's middle call returns a 307, purge immediately** —
Caching → Configuration → Purge Everything in the dashboard (there is no purge
tooling and the CI token has no `Zone.Cache Purge` scope) — then set
`enabled: false` on the rule in `infra/cloudflare/config.ts` and re-apply.

Then confirm it actually moved the needle: Railway `web` CPU and the Postgres
query rate should fall, and Cloudflare Analytics → Caching should show a
non-trivial cached share of HTML requests on www.

Rolling back is the usual one-liner: `enabled: false` on
`boardsesh:www-html-edge-cache` and `vp run cf:apply -- --apply`. That stops new
entries but does **not** evict what is already cached, so pair it with a purge
whenever the reason for rolling back is a wrong cached response.

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
`strict` is safe. `ota.boardsesh.com` is DNS-only and unaffected;
`*.preview.boardsesh.com` rides a Cloudflare Tunnel, which does not use the
zone's origin-encryption mode. The apex became proxied with the redirect rule
above, but it is originless — there is no origin connection for the zone SSL
mode to govern, so it needs no cert check.

### Rollback

For a bad board-render cache rule, set the matching rule's `enabled` field to
`false` in `infra/cloudflare/config.ts` and run `vp run cf:apply -- --apply`.
For a bad renderer deployment, roll back the web and Railway releases together;
the compatibility path remains routed to Railway. Grey-cloud `ws` only for a
Cloudflare proxy incident, because doing so removes edge caching from both image
endpoints and sends their full load directly to Railway.
