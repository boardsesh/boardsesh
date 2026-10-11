# Public REST API rate limiting

The ten live public `GET /api/v1/*` routes share one client-IP budget: **120 requests per 60 seconds**. The budget is aggregate, so a climb-details request and a climb-stat request from the same IP spend the same `public-api-v1:get` bucket. The unlisted spray-wall photo path also keeps its stricter 60-per-minute local cap because each miss asks the backend to mint a signed URL.

Responses served directly from the CDN cache never invoke a route and do not spend the budget. Cache misses and uncacheable reads do. A rejected origin request returns `429`, a positive `Retry-After` value, and explicit browser/CDN `no-store` headers.

The current inventory is pinned by `public-api-rate-limit-coverage.test.ts`: nine OpenAPI-documented reads plus the unlisted spray-wall photo redirect. Main has retired the old heatmap and Aurora proxy routes; do not restore them as part of this policy.

## Identity trust boundary

Vercel requests use only a singular `x-vercel-forwarded-for` value when `VERCEL=1`, matching Vercel's [request-header contract](https://vercel.com/docs/headers/request-headers). `VERCEL_ENV` alone is not proof that a request crossed Vercel.

Railway requests are identified by the platform-provided `RAILWAY_ENVIRONMENT_ID`. Railway documents `X-Real-IP` as the request's remote IP in its [public networking specification](https://docs.railway.com/networking/public-networking/specs-and-limits). If that remote peer belongs to one of Cloudflare's published proxy ranges, the guard uses the singular `CF-Connecting-IP` visitor address. Otherwise it uses the Railway remote address and ignores `x-forwarded-for` and `cf-connecting-ip`. The CIDRs in the web guard match Cloudflare's [published IPv4](https://www.cloudflare.com/ips-v4) and [IPv6](https://www.cloudflare.com/ips-v6) ranges as checked on 2026-10-04; update the list when Cloudflare publishes a change.

Missing or malformed platform values and invalid Cloudflare visitor values use one shared `unknown` identity. IPv4-mapped IPv6 is normalized to IPv4, and IPv6 callers share a `/64` bucket so rotating host addresses cannot mint new buckets.

The official header documentation describes the intended roles, but this change does not verify that Railway overwrites caller-supplied `X-Real-IP` on Boardsesh's actual public host. Before treating this as an anti-spoof boundary, an operator must verify the header behavior for both Cloudflare-proxied `www` and the direct Railway domain, then address any direct-origin bypass. Unit tests exercise the selection logic; they cannot establish what the live edge sends.

## Two enforcement tiers

1. A bounded in-process map rejects bursts without a network round trip. Expired identities are pruned and the oldest identity is evicted before the map can exceed 10,000 entries.
2. Redis runs the shared atomic `INCR` + `EXPIRE` Lua script, so separate instances in one deployment environment spend the same fixed-window bucket.

The Redis client is lazy and has 300 ms connect and command timeouts, no offline queue, no command retry, and no reconnect loop. A transport failure opens a 30-second circuit. After the cooldown, one request probes Redis while concurrent requests stay on Tier 1. Redis failures fail soft because Tier 1 has already run; an actual shared-store limit rejection never fails soft.

Vercel Production and Preview use separate namespaces. Railway namespaces use `RAILWAY_ENVIRONMENT_ID`, which Railway documents as the service environment ID; local runs use a separate local namespace. A missing `REDIS_URL` in a hosted environment emits one warning per warm process and leaves only the bounded local tier active.

## Distributed enforcement prerequisite

`REDIS_URL` must already point to a reachable shared Redis service for every hosted environment that needs a cross-instance cap. This PR does not provision a store or change host variables. The remaining deployment proof is to confirm Redis reachability and same-client aggregation across separate web instances in Production and Preview. Until that proof exists, describe the guard as source-ready with local fallback, not as a proven distributed production limit.

## Shared networks and photo traffic

The aggregate limit is per public IP, so a gym, school, or office behind one NAT shares 120 origin requests per minute. Signed-in heatmap reads are no longer a live route. The unlisted spray-wall photo redirect remains anonymous, gets the aggregate cap, and keeps its additional local cap because each uncached miss signs a private image URL. If traffic shows busy gyms hitting the ceiling, adjust the documented policy deliberately rather than adding a route-specific bypass that reopens aggregate scraping.

## Code map

- `packages/shared/rate-limit` — bounded local limiter, normalized IP and CIDR checks, Redis Lua/key logic, and structured limit error.
- `packages/web/app/lib/public-api-rate-limit.server.ts` — Vercel/Railway identity selection, aggregate policy, and `429` response.
- `packages/web/app/lib/public-api-rate-limit-redis.server.ts` — Redis connection, timeouts, and circuit breaker.
- `packages/backend/src/utils/redis-rate-limiter.ts` — backend adapter using the same shared Redis core.
