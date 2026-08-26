# Vercel compute baseline (www)

The burn-hunt write-up for [#4650], and the CPU/memory baseline [#4648] Phase 2 needs to size the
Railway web container.

**Status: partially filled as of 2026-08-28.** The Vercel MCP was authenticated on 2026-08-25, which
unblocked the *invocation* rows — §5's table now carries measured post-wave traffic, and §2b records
exactly how. It did **not** unblock the CPU and memory rows: the MCP exposes logs, error clusters,
analytics and deployment tools, and **no metric of CPU, memory, or origin transfer at all**. Those
cells are still TODO, and the container-size recommendation is still blocked. `VERCEL_TOKEN` for
`vercel metrics` remains the only known way to get them — §2 has the literal commands.

An obviously-empty cell beats a number nobody can trace back to a query. In particular: **an
invocation count is not a CPU measurement**, and nothing below substitutes one for the other.

> **Do not turn the Observability ingest down before the pull runs.** [#4648] Phase 0 gates both the
> Speed Insights cancellation and the Observability-tier downgrade on "after #4650's data pull".
> `vercel metrics` reads Observability, and Observability Plus is what makes per-route function
> metrics available at all. Downgrading first destroys the data this document is waiting for.

---

## 1. Pre-wave baseline — Aug 18–21, 2026

From [#4648]'s billing table, measured 2026-08-21, three days into the Aug 18 – Sep 17 cycle. Shown
as arithmetic so every figure can be re-derived:

| Line                     | 3-day usage | Per day                        | Charge (3 days) |
| ------------------------ | ----------- | ------------------------------ | --------------- |
| Fluid Active CPU         | 127 h       | 127 ÷ 3 = **42.3 CPU-h/day**   | $16.56          |
| Fluid Provisioned Memory | 373 GB·h    | 373 ÷ 3 = **124.3 GB·h/day**   | $4.06           |
| Function Invocations     | 1.8 M       | 1.8 ÷ 3 = **600 k/day** (≈7/s) | $1.08           |
| Fast Origin Transfer     | 101 GB      | 101 ÷ 3 = **33.7 GB/day**      | $6.29           |
| Observability Events     | 6.89 M      | 6.89 ÷ 3 = **2.30 M/day**      | $8.27           |

Provisioned memory is _provisioned_, not resident. 124.3 GB·h/day ÷ 24 = 5.18 GB mean provisioned,
which is a billing quantity, not a working-set size. Railway has to be sized on peak RSS, and only
the metrics pull gives that.

## 2. How to reproduce, and the two windows

The Vercel MCP server has no metrics tool. `vercel metrics` (CLI v54.1.0) queries Observability
directly and groups by dimension. `-t $VERCEL_TOKEN` runs it headlessly; without a token the CLI
drops into an interactive device-code login and an agent cannot get past it.

**Windows, pinned to real timestamps** (`gh pr view <n> --json mergedAt`, `gh run list --workflow
production-deploy.yml`):

- **Pre-wave**: `--since 2026-08-19T00:00:00Z --until 2026-08-22T00:00:00Z`. Ends before the first
  wave merge ([#4661], 2026-08-22T00:23:50Z), so it is clean regardless of deploy latency.
- **Post-wave**: `--since 2026-08-23T09:00:00Z`. The last wave deploy ([#4685]) finished its
  production-deploy run at 2026-08-23T08:50:12Z.

```bash
export VERCEL_TOKEN=…   # scope: the boardsesh team

# 1. Enumerate what this team can actually query, and confirm the dimension
#    names below exist on each metric before relying on them.
vercel metrics schema -t "$VERCEL_TOKEN"
vercel metrics schema vercel.function_invocation -t "$VERCEL_TOKEN"

# 2. Invocations by route, both windows.
vercel metrics vercel.function_invocation.count --group-by route --limit 25 \
  --since 2026-08-19T00:00:00Z --until 2026-08-22T00:00:00Z -F json -t "$VERCEL_TOKEN"
vercel metrics vercel.function_invocation.count --group-by route --limit 25 \
  --since 2026-08-23T09:00:00Z -F json -t "$VERCEL_TOKEN"

# 3. Duration by route (CPU-per-invocation = the cpu metric ÷ invocations, per route).
vercel metrics vercel.function_invocation.request_duration_ms -a avg --group-by route \
  --since 2026-08-19T00:00:00Z --until 2026-08-22T00:00:00Z -F json -t "$VERCEL_TOKEN"

# 4. Whatever cpu / memory metric ids step 1 reports, same two windows, --group-by route.
#    p95 and peak matter more than the mean here — see §5.

# 5. CDN hit ratio per route. This is the number §3 is missing.
vercel metrics vercel.request.count --group-by cache_result \
  -f "route eq '/api/internal/board-render'" --since 24h -F json -t "$VERCEL_TOKEN"

# 6. Billing top line, as a cross-check on §1.
vercel usage -t "$VERCEL_TOKEN"
```

The exact metric ids and dimension names in steps 2–5 have **not** been verified against this team's
Observability — that needs the token. `vercel metrics schema` is authoritative; if `cache_result` or
`route` is spelled differently there, use what it says.

## 2b. What the Vercel MCP could and could not answer (2026-08-28)

The MCP path is cheaper than the token path and worth trying first, so this records what it actually
returns. Session anchored at **2026-08-28T04:25:54Z**, project `boardsesh`, team
`marcodejonghs-projects`, `environment: production` on every call. (Both MCP tools accept the slug in
place of the `prj_…` / `team_…` id, so the ids are not reproduced here.)

**Tools that exist:** `get_runtime_logs`, `get_runtime_errors`, `get_web_analytics`,
`list_deployments`, `get_project`, `list_projects`, `list_teams`, plus documentation/purchase/toolbar
tools. **Tools that do not exist:** anything returning CPU time, memory, RSS, concurrency, or origin
transfer. There is no `metrics`, `usage`, or `billing` tool. `get_runtime_logs` at `limit: 4` was
checked line-by-line to be sure the payload carries no hidden fields — a function log line is
`dep=<deploymentId> cache=<HIT|MISS>` and a status code, with **no duration and no memory**. That is
why the CPU and RSS rows in §5 are still TODO.

### The 24-hour truncation trap

**`get_runtime_logs` with `since: 24h` is silently truncated.** Reproduced independently here, three
windows against the same anchor, `group_by: source`, counting the `function` bucket:

| Window  | `function` count | Scale | Implied per day |
| ------- | ---------------- | ----- | --------------- |
| 30 min  | 6,523            | ×48   | **313,104**     |
| 6 h     | 68,540           | ×4    | **274,160**     |
| 24 h    | 185,921          | ×1    | 185,921         |

The two short windows agree within 13%; the 24-hour window under-reports them by 32–41%. It is not a
traffic shape — it is truncation, and it reproduces on `group_by: route` too. **Derive every daily
rate from a 30 min or 6 h window and scale.** Anyone re-running this on `since: 24h` will conclude the
remediation worked substantially better than it did.

`source: ["serverless"]` is the `function` bucket 1:1 with invocations: the per-route counts sum to
68,126 of the 68,540 `function` total over the 6 h window, with the residual in the 17 routes below
the display cut-off.

### Reconciliation against the 2026-08-26 numbers on [#4650]

Marco's post-fix window was 2026-08-26T20:13Z → 2026-08-27T02:13Z. Re-querying that **exact** window:

| Route                    | This pull (6 h ×4) | [#4650] comment 2026-08-26 | Delta     |
| ------------------------ | ------------------ | -------------------------- | --------- |
| Function invocations     | 148,432            | ~133,300                   | +11%      |
| — climb view             | **83,728**         | **~83,700**                | **match** |
| — `board-render`         | 49,820             | ~35,300                    | +41%      |
| — `/setter/[username]`   | 9,456              | ~7,800                     | +21%      |

Climb view matches to four significant figures, so the window and the method are the same. The
`board-render` gap is therefore real rather than methodological, and the most likely cause is
late-arriving log ingestion after the comment was written. Recorded as a disagreement rather than
silently overwritten: the **−84% board-render** figure in that comment is probably nearer **−77%**,
and the stated `0.42 : 1` board-render-to-climb-view ratio measures **0.595 : 1** on the same window
today. The wave still worked; the win was slightly smaller than first posted.

### Traffic has climbed back since the wave

Same-clock 6 h windows (22:25Z → 04:25Z), scaled ×4:

| Night     | Climb view | `board-render` | `/setter` | Ratio br : cv |
| --------- | ---------- | -------------- | --------- | ------------- |
| Aug 25→26 | 87,688     | 42,112         | 9,456     | 0.48 : 1      |
| Aug 26→27 | 96,368     | 59,204         | 13,004    | 0.61 : 1      |
| Aug 27→28 | 154,376    | 86,844         | 22,240    | 0.56 : 1      |

Climb view is up **76%** in two nights. The ~133 k/day low-water mark recorded on 2026-08-26 was a
trough, not the new steady state, and any sizing done off that single figure would undershoot.

### A new failure mode that outranks CPU for sizing

`get_runtime_errors` over 24 h returns 50 clusters. The top three by volume:

| Cluster                                              | Count | Users | First seen               |
| ---------------------------------------------------- | ----- | ----- | ------------------------ |
| `Front door: similar-climbs unavailable` (AbortError) | 1,554 | 299   | 2026-08-22T11:42:43Z     |
| `i: sorry, too many clients already`                  | 759   | 230   | **2026-08-27T23:35:52Z** |
| `Error fetching results or climb: … too many clients` | 753   | 230   | 2026-08-10T04:05:17Z     |

`sorry, too many clients already` is Postgres `53300` (`InitProcess`, `severity: FATAL`) —
**connection-slot exhaustion**, not CPU. It appears on climb view and `/list`, and it tracks the
traffic rise in the table above. `get_runtime_logs` with `statusCode: 500` over the 6 h window puts
**761** 500s on climb view and 12 on `/list`, so roughly **3,090 user-visible 500s/day**.

**It is a burst, not a continuous outage.** First seen 2026-08-27T23:35:52Z, last 2026-08-28T03:52:25Z
— about 4h15m, inside the overnight crawl peak — and the 30 min window ending 04:25Z shows 1 error in
5,528 invocations. That makes it worse to detect, not better: it will recur on the next peak and
nothing alerts on it. The second cluster of 753 is very likely the same events logged at a wrapping
call site, so the two do not sum.

This matters for [#4648] Phase 2 well beyond this document: the binding constraint on the web tier
right now is the **Postgres connection ceiling**, not vCPU. A Railway container sized purely on CPU
would hit the same wall on day one. Sizing needs a pooler decision (PgBouncer / transaction pooling)
alongside the CPU number. Filed as **[#4842]** — and it is the scenario [#4461] predicted in writing
before being closed on 2026-08-15 without the pool-sizing decision being made.

## 3. Where the compute goes

Marco's 24-hour grouped-log ranking from 2026-08-22, with each row's merged fix. Log-line counts
carry one middleware plus one function line per request, so halve them for requests.

| Route                        | 24h log lines   | Fix                                                                  | Merged                      |
| ---------------------------- | --------------- | -------------------------------------------------------------------- | --------------------------- |
| `/api/internal/board-render` | 101,659         | OOM pack: LRU caches, sharp tuning, render semaphore, `memory: 3009` | [#4675]                     |
| climb-view SSR               | 86,773          | CDN TTL 3600 → 86400 s, ×7 SWR                                       | [#4685], gated on [#4592]   |
| sticky-locale 307s           | ~15k/day        | crawler gate on the redirect + cookie write                          | [#4667], widened in [#4716] |
| edge middleware              | 218,219 inv/day | matcher narrowed off `/api/internal/**`                              | [#4667]                     |
| sitemap shards               | —               | climb-URL store; page 1 origin miss 51 s → 0.088 s                   | [#4552] → [#4661]           |

### board-render: what the 101,659 does and does not say

The earlier note on [#4650] read this as "100% cache MISS — one unique URL per climb, fetched once —
so no cache-header change can fix it". Both halves are wrong, and the correction matters because
this is the justification for deferring the single biggest CPU lever.

**~50k/day is the origin-MISS count, not a miss rate.** A CDN hit never invokes the function, so
function log lines cannot contain a hit by construction. The number says how many renders reached
the origin. It says nothing about how many fetches there were.

**The URL is not unique per fetch, and not per locale.** `buildBoardRenderUrl`
(`packages/web/app/components/board-renderer/util.ts:29`) builds a deterministic query string from
`board_name`, `layout_id`, `size_id`, `set_ids` and `frames` — no nonce, no locale, no timestamp.
Verified 2026-08-24 by extracting the board-render URLs from the `/` and `/es` twins of the same
climb page: byte-identical. So all four locale twins, both view trees, the front door and every list
thumbnail request the same URL, and they share one cache entry.

**It does cache.** Same date, a real board-render URL fetched twice:

```
fetch 1: x-vercel-cache: MISS   cache-control: public, max-age=31536000, s-maxage=31536000, immutable
fetch 2: x-vercel-cache: HIT    (same headers)
```

So the honest statement is narrower than the old one, and still supports the same conclusion: the
headers are already the maximum possible (`Vercel-CDN-Cache-Control: public, s-maxage=31536000,
immutable`, `packages/shared/board-render/src/headers.ts`), so **no header change can improve them**
— but the true hit ratio is **unmeasured**. Pull it with step 5 above before anyone sizes anything
off "50k renders/day".

Two things to watch when comparing windows:

- [#4667] removed `/api/internal/**` from the middleware matcher on 2026-08-22, changing this route's
  middleware exposure mid-window. Pre- and post-wave hit rate must be **compared**, not assumed equal.
- Cloudflare fronts www and returns `cf-cache-status: DYNAMIC` for board-render, so it is not caching
  the image at its own edge either. Every Vercel-CDN miss _and_ every Cloudflare pass-through reaches
  the origin. That is a lever [#4652] owns.

Resolved by [#4715]: new web URLs point directly at Railway `/render/board`, while the old www URL
is an external compatibility rewrite for released clients. The Vercel function, its 3009 MB
override, and its route-specific file tracing are gone. Railway shares the renderer caches and
load-shedding semaphore with `/og/climb`, and Cloudflare edge-caches the new exact path.

### Routes ruled out, with the arithmetic

**Crons are not the burner.** `packages/web/vercel.json` declares eight, and `maxDuration` is a
ceiling, not a runtime. Absolute worst case, every cron burning its full ceiling every time:

| Cron                                        | Schedule      | Runs/week | maxDuration | Worst case CPU-s/week |
| ------------------------------------------- | ------------- | --------- | ----------- | --------------------- |
| `/api/internal/prewarm-heatmap/kilter`      | `0 4 * * 0`   | 1         | 300         | 300                   |
| `/api/internal/prewarm-heatmap/tension`     | `15 4 * * 0`  | 1         | 300         | 300                   |
| `/api/internal/prewarm-heatmap/decoy`       | `30 4 * * 0`  | 1         | 300         | 300                   |
| `/api/internal/prewarm-heatmap/touchstone`  | `45 4 * * 0`  | 1         | 300         | 300                   |
| `/api/internal/prewarm-heatmap/grasshopper` | `0 5 * * 0`   | 1         | 300         | 300                   |
| `/api/internal/profile-percentiles`         | `0 6 * * 0`   | 1         | 300         | 300                   |
| `/api/internal/cleanup`                     | `0 5 * * *`   | 7         | 60          | 420                   |
| `/api/internal/refresh-sitemap-climbs`      | `0 */6 * * *` | 28        | 300         | 8,400                 |
| **Total**                                   |               |           |             | **10,620**            |

10,620 CPU-s/week = 1,517 CPU-s/day = **0.42 CPU-h/day**, or **1.0%** of 42.3. The two daily/6-hourly
crons are five times the weekly ones put together, so they are worth naming — but the conclusion
holds comfortably. Ruled out on arithmetic, not on vibes.

**Adding `Vercel-CDN-Cache-Control` to more SSR routes** buys nothing. The header is set for `/list`
and `/view/[climb_uuid]` only (`packages/web/middleware.ts`). Every other candidate fails a test:
`/setter/[username]` and `/gym/[slug]` are declared-empty sitemap shards, so they carry
link-discovery volume only and appear in none of the top rows; `/b/[board_slug]` is in no shard;
`/play/[climb_uuid]` does a real `getClimb` then `permanentRedirect`, but nothing in the site
produces a `/play/` URL any more, so its volume is residual index entries; and
`/profile/[user_id]` **must not** be cached — see §7. Add nothing here unless the metrics pull
actually puts one of these in the top routes.

**The locale twins do cache — but the TTL bump converts re-fetches, not first passes.** The
`/es|/fr|/de` twins set `boardsesh-locale` on every visit, and Vercel's general guidance is that a
`Set-Cookie` response is uncacheable. That is **not** what this deployment does. Verified 2026-08-24
on a real `/es` climb-view URL: `set-cookie: boardsesh-locale=es` alongside `cdn-cache-control:
s-maxage=86400, stale-while-revalidate=604800`, `x-vercel-cache: HIT`, `age: 661`.

The limit is arithmetic, not correctness. Production emits 52,842 climb items
(`packages/web/app/lib/seo/sitemap/entries.ts`), which is 211,368 URLs across the four locales,
against roughly 40k climb-view fetches/day. A breadth-first crawl revisits a given URL about every
five days — outside the 24-hour fresh window. So the bump earns its keep on re-fetches within a day
and on the 7-day stale-while-revalidate window (which serves a stale body but still triggers an
origin render). Its actual effect is **unmeasured**; step 5 with
`-f "route eq '/view/[climb_uuid]'"` is the query that settles it.

## 4. The headless swarm

PostHog project 412845, human web pageviews:

| Window                        | Pageviews  | Distinct persons |
| ----------------------------- | ---------- | ---------------- |
| 2026-08-10 → 08-21 (baseline) | 99–289/day | 33–89/day        |
| 2026-08-22                    | 2,054      | **2,031**        |
| 2026-08-23                    | 754        | 686              |

Hourly: a first burst 08-22 02:00–07:00Z ramping 42 → 463/hr, a second 08-22 21:00Z → 08-23 02:00Z
peaking at 382/hr, then back to ≤16/hr from 08-23 03:00Z.

Signature is a headless-browser farm on residential proxies: uniform `$screen_width` 1920,
`$referring_domain` null on **every** event, exactly one pageview per person, UAs rotated across
Chrome/Firefox/Edge on Windows and Mac (536/389/387/365), geo spread US 512 / SG 493 / BD 168 /
HK 158 / FR 95 / GB 89 / ES 69 / OM 69. Paths are ~2,500 distinct climb-view URLs, heavily `/es`,
`/de` and `/fr` prefixed — the locale-twin walk, caught in the act by a crawler that happens to
execute JS.

Scale check: ~1,400 SSR renders/day against the ~40k/day in the server logs, so about **3.5%**. This
is context, not the burner — and PostHog cannot be substituted for the metrics pull, because it only
ever sees clients that execute JS and therefore misses roughly 96% of the crawl.

It also proves a UA list can never be the whole answer. **Recommendation:** a Cloudflare Bot Fight
Mode or rate-limit rule on www. Free tier, already fronting the domain, and it survives the Railway
cutover where a `vercel firewall` rule would be thrown away. Dashboard action — fold it into [#4652],
which already owns Cloudflare config for www.

## 5. Railway sizing for #4648 Phase 2 — invocations measured, CPU still blocked

42.3 CPU-h/day ÷ 24 = **1.76 vCPU, 24-hour mean utilisation** (pre-wave).

**Do not size a container on that number.** Fluid autoscales horizontally, so CPU-hours ÷ 24 says
nothing about how much CPU is wanted at once at peak, and the traffic is nowhere near flat — §4's own
series swings about 29× between peak (463/hr) and trough (≤16/hr). A single Railway container has to
survive the peak, not the mean.

Three columns, because two remediation waves landed rather than one:

- **Pre-wave (Aug 19–21)** — §1's billing arithmetic.
- **Post-wave-1 (Aug 26)** — after [#4675]/[#4685]/[#4667]; the [#4650] comment of 2026-08-26,
  re-derived here on its own window (§2b).
- **Post-wave-2 (Aug 28)** — after [#4764]/[#3837]/[#4716]/[#4677]; this pull, 6 h window
  2026-08-27T22:25Z → 2026-08-28T04:25Z, ×4, cross-checked against a 30 min window.

|                          | Pre-wave (Aug 19–21) | Post-wave-1 (Aug 26) | Post-wave-2 (Aug 28)  |
| ------------------------ | -------------------- | -------------------- | --------------------- |
| CPU-h/day                | 42.3                 | **TODO** ¹           | **TODO** ¹            |
| 24-h mean vCPU           | 1.76                 | **TODO** ¹           | **TODO** ¹            |
| p95 concurrent CPU       | **TODO** ¹           | **TODO** ¹           | **TODO** ¹            |
| Peak concurrent CPU      | **TODO** ¹           | **TODO** ¹           | **TODO** ¹            |
| Peak RSS                 | **TODO** ²           | **TODO** ²           | **TODO** ²            |
| Invocations/day          | 600 k                | 148 k                | **274 k – 313 k**     |
| — climb view             | —                    | 83.7 k               | 154 k                 |
| — `board-render`         | —                    | 49.8 k               | 86.8 k                |
| — `/setter/[username]`   | —                    | 9.5 k                | 22.2 k                |
| Middleware invocations   | 218 k                | 111 k                | 197 k – 225 k         |
| Sticky-locale 307s/day ⁴ | ~15 k                | 14.2 k               | 12.4 k                |
| Fast Origin Transfer/day | 33.7 GB              | **TODO** ³           | **TODO** ³            |

¹ **No CPU metric exists in the Vercel MCP.** Tried `get_runtime_logs` (no duration field on any log
line, verified at `limit: 4`), `get_runtime_errors`, `get_web_analytics`, `list_deployments`,
`get_project`. A tool search across the whole MCP surface for metrics/CPU/memory/usage/billing
returns only `search_vercel_documentation` and the purchase tools. Needs `vercel metrics` with a
`VERCEL_TOKEN` — §2.

² **No memory metric either**, same tools, same result. Fluid *provisioned* memory is in the §1
billing table but provisioned ≠ resident, so it cannot stand in for peak RSS.

³ **No transfer metric in the MCP.** It is a billing quantity; `vercel usage` or the dashboard is the
source. Deliberately not estimated from response sizes × invocations — that would be a fabricated
number in a row that reads as measured.

⁴ 307s are `statusCode: 307` filtered, not the raw `redirect` bucket, which also carries the climb-slug
308s. On the Aug 28 window the two differ by 146 lines in 6 h; on the Aug 26 window they are the same
to within one line. The 307s have barely moved across either wave — the observation behind [#4802].

### What was measured per request (2026-08-28, against production)

These are wall-clock, not CPU-seconds, and are recorded as such:

- **`board-render`** — `server-timing: wasm;dur=6.1, sharp;dur=389.4, compose;dur=389.3,
  cache;desc=base-hit`, so **~396 ms wall** for a 246,558-byte WebP at `memory: 3009`.
- **`board-render` is now served by Cloudflare** — `cf-cache-status: HIT`, 34 ms client-observed,
  under `cache-control: public, max-age=31536000, immutable`. [#3837] is live and working. The URL
  now carries a `&v=<hash>` renderer version, confirming [#4773] shipped as well.
- **Climb view** — 3.35 s cold, `x-vercel-cache: MISS`, `cf-cache-status: DYNAMIC`, 301,514 bytes
  raw. Reproduces the 2026-08-25 measurement on [#4650] exactly.

**`sharp;dur` is not CPU time.** libvips is multi-threaded, so the CPU-seconds behind a 389 ms
`sharp` span may be a multiple of it, and the span also contains I/O wait. Multiplying 396 ms by
86,844 renders/day yields ~9.6 CPU-h/day for `board-render` alone, but that arithmetic is only sound
if the step is single-threaded and CPU-bound, and neither is established. It is **not** entered in
the table above for that reason.

### Container size recommendation: still blocked

**Blocked on p95 and peak concurrent CPU, and on peak RSS — none of which the MCP can produce.**
What would unblock it, in order of preference:

1. **A `VERCEL_TOKEN` scoped to the boardsesh team.** `vercel metrics` (CLI v54.1.0) is the only
   thing that groups CPU by route, and §2 already has the four literal commands and both windows.
   Everything else here is a workaround for its absence.
2. Failing that, the Vercel dashboard's Observability → Compute view, read by hand, for the same two
   windows.

Three things will move the answer materially even once the CPU number lands:

- The `/api/internal/board-render` work moved to Railway in [#4715], so the next sizing pass must
  refresh the Vercel measurements after that cutover instead of treating the pre-cutover route as
  part of the web container.
- **Postgres connection slots, which are the binding constraint today, not vCPU** (§2b, [#4842]).
  ~3,090 500s/day are `53300` connection-slot exhaustion, in bursts at crawl peak. Sizing this
  container on CPU alone reproduces it on Railway.
- Traffic is trending back up — climb view rose 76% between the nights of Aug 25 and Aug 27 — so the
  post-wave figures are a moving target rather than a settled floor.

## 6. Follow-ups filed from this write-up

- **[#4715] — move `/api/internal/board-render` off the Vercel function.** Implemented: Railway now
  serves `/render/board`; www retains a routing-only compatibility rewrite. See §3.
- **Cloudflare bot rule for the headless swarm** (§4) → [#4652].
- **`NEXTAUTH_URL` is still `http://localhost:3000` in the Vercel prod env** — dashboard,
  @marcodejongh. Logs a warning on every cold start.

Still open with existing owners, cited here and not absorbed: [#4664] (WASM 3-copy), [#4665]
(CDN purge-by-tag), [#4652] (Cloudflare edge caching), [#4648] (the migration epic).

## 7. Known non-cacheable indexable surfaces

[#4652] adds Cloudflare cache rules for www. It must **not** blanket-cache the page tree.

- **`/profile/[user_id]`** reads `getServerAuthToken()` and `getServerSession()` at the top of
  `page.tsx`, so its HTML is session-derived. A shared CDN entry would serve one viewer's rendering
  to everyone. It is indexable but must stay uncached.
- Anything else that grows a `getServerSession` call joins this list. The safe rule is to cache by
  explicit route allow-list — the same shape `getListPageCacheTTL` / `getClimbViewPageCacheTTL`
  already use in `packages/web/app/lib/list-page-cache.ts` — not by exclusion.

## 8. Open questions

- **Should the sticky-locale cookie be written only on an explicit language-switcher action**,
  instead of on every non-default-locale page view? That kills the crawler-cookie class outright, no
  UA list required. But `middleware.ts` documents the current behaviour as deliberate product design
  ("a shared /es/… link from a friend persists for the recipient too"), so it is a product call.
- **Should the four SEO scrapers get a `Disallow: /` in robots.txt?** `packages/web/app/robots.ts`
  emits a single `userAgent: '*'` group today. A per-agent group — or a Cloudflare rule — would
  remove the whole SSR render for those agents, not just the 307: strictly stronger than the UA gate
  in [#4716].
  Cloudflare is already doing exactly this for the AI crawlers (probed 2026-08-24: ClaudeBot,
  Claude-User, PerplexityBot, GPTBot, OAI-SearchBot, ChatGPT-User, Bytespider, Amazonbot, CCBot,
  PetalBot and meta-externalagent all get `HTTP/2 403` from `server: cloudflare` and never reach
  Vercel), which proves the mechanism is available and in use. **Do not apply it blind:**
  AhrefsSiteAudit and SemrushBot may be our own SEO tooling, and blocking them would silently break
  it. Needs a call from @marcodejongh on which of the thirteen are ours.
- **Should `Sec-Fetch-Mode: navigate` (or its absence) join the crawler gate as a second predicate?**
  It would catch the §4 swarm, which no UA list can. But Safari before 16.4 and a long tail of older
  browsers send no `Sec-Fetch-*` at all, and unlike a UA list there is no way to enumerate who would
  lose sticky locale. Worth revisiting once the metrics pull shows whether the loop still costs
  anything; not worth it blind.
- **Should `+http` join the crawler pattern as a generic heuristic?** Crawlers conventionally put
  `+https://example.com/bot.html` in their UA and no mainstream browser does, so the false-positive
  risk is low and it would auto-cover crawlers nobody has named. Left out to keep the gate one
  reviewable idea; first thing to add if the token list starts needing monthly edits.
- **Noindexing or dropping hreflang on the `/es`, `/fr`, `/de` climb twins** to cut the 211k-URL
  crawl surface by 4× is _not_ recommended, and the cost argument for it has been removed rather than
  restated: §3 shows the twins do cache, and the actual saving is unmeasured. This is an SEO
  decision. `entries.ts` already made it and wrote down why — climbs fan out to the default locale
  only in the sitemap while `createPageMetadata` emits reciprocal HTML `alternates.languages` for all
  four locales, which is symmetric by construction. Trading four-language organic reach for an
  unmeasured CPU saving is a bad trade.

[#3795]: https://github.com/boardsesh/boardsesh/pull/3795
[#3798]: https://github.com/boardsesh/boardsesh/pull/3798
[#3837]: https://github.com/boardsesh/boardsesh/pull/3837
[#4271]: https://github.com/boardsesh/boardsesh/pull/4271
[#4461]: https://github.com/boardsesh/boardsesh/issues/4461
[#4552]: https://github.com/boardsesh/boardsesh/issues/4552
[#4592]: https://github.com/boardsesh/boardsesh/pull/4592
[#4648]: https://github.com/boardsesh/boardsesh/issues/4648
[#4650]: https://github.com/boardsesh/boardsesh/issues/4650
[#4652]: https://github.com/boardsesh/boardsesh/issues/4652
[#4661]: https://github.com/boardsesh/boardsesh/pull/4661
[#4664]: https://github.com/boardsesh/boardsesh/issues/4664
[#4665]: https://github.com/boardsesh/boardsesh/issues/4665
[#4667]: https://github.com/boardsesh/boardsesh/pull/4667
[#4675]: https://github.com/boardsesh/boardsesh/pull/4675
[#4677]: https://github.com/boardsesh/boardsesh/pull/4677
[#4685]: https://github.com/boardsesh/boardsesh/pull/4685
[#4715]: https://github.com/boardsesh/boardsesh/issues/4715
[#4716]: https://github.com/boardsesh/boardsesh/pull/4716
[#4764]: https://github.com/boardsesh/boardsesh/pull/4764
[#4773]: https://github.com/boardsesh/boardsesh/issues/4773
[#4802]: https://github.com/boardsesh/boardsesh/issues/4802
[#4842]: https://github.com/boardsesh/boardsesh/issues/4842
