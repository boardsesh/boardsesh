# Public REST API rate limiting

The ten public `GET /api/v1/*` routes share one client-IP budget: **120 requests per 60 seconds**. The budget is aggregate, so a climb-details request and a heatmap request from the same IP spend the same `public-api-v1:get` bucket.

Responses served directly from Vercel's CDN cache never invoke a route and do not spend the budget. Cache misses and uncacheable reads do. A rejected origin request returns `429`, a positive `Retry-After` value, and explicit browser and Vercel CDN `no-store` headers.

The five legacy `/api/v1/*/proxy/*` POST routes are outside this limiter. They are authenticated/write flows rather than public reads and are being retired separately.

## Identity trust boundary

On Vercel, the web app trusts only a singular `x-vercel-forwarded-for` value and only when the platform sets `VERCEL=1`. Vercel overwrites that header, so a caller cannot choose a new bucket by sending their own value. `VERCEL_ENV` alone is not proof that a request crossed Vercel; branch deployments may set it themselves. Keep this aligned with Vercel's [request-header contract](https://vercel.com/docs/headers/request-headers).

The value must be one valid IP. Comma-separated chains, invalid values, missing headers, and every non-Vercel request use one shared `unknown` identity. IPv4-mapped IPv6 is normalized to IPv4, and IPv6 callers share a `/64` bucket so rotating host addresses cannot mint new buckets.

The safe fallback is intentionally strict. A non-Vercel deployment that needs per-client enforcement must add an explicit trusted-proxy mode based on its actual last-hop contract; do not start trusting the first `x-forwarded-for` value.

## Two enforcement tiers

1. A bounded in-process map rejects bursts without a network round trip. Expired identities are pruned and the oldest identity is evicted before the map can exceed 10,000 entries.
2. Redis runs the shared atomic `INCR` + `EXPIRE` Lua script, so separate Vercel instances spend the same fixed-window bucket.

The Redis client is lazy and has 300 ms connect and command timeouts, no offline queue, no command retry, and no reconnect loop. A transport failure opens a 30-second circuit. After the cooldown, one request probes Redis while concurrent requests stay on Tier 1. Redis failures fail soft because Tier 1 has already run; an actual shared-store limit rejection never fails soft.

Production, preview, and local counters have separate key namespaces. Preview traffic cannot drain the production budget.

## Provision Redis for Vercel

The Railway backend's internal Redis hostname is not automatically available to Vercel. Configure a separately reachable Redis URL for the web project:

1. Provision an internet-reachable Redis endpoint with TLS and authentication. A portable Redis service is fine; no vendor-specific rate-limit API is required.
2. Add its connection string as `REDIS_URL` in the Vercel project settings for both Production and Preview. Prefer a `rediss://` URL when the provider supports TLS.
3. Redeploy both environments. Vercel applies new environment variables only to new deployments.
4. Confirm function logs no longer contain the one-shot warning: `REDIS_URL is not configured for the Vercel web deployment`.
5. From two deployment instances, send requests with the same test client IP. The combined 121st origin request in one 60-second window must return `429`.

Until `REDIS_URL` is set and reachable, logs emit one missing-configuration warning per warm process and only Tier 1 is active. That protects each instance but is not a strict cross-instance cap.

## Shared networks and heatmap traffic

The limit is per public IP, so a gym, school, or office behind one NAT shares 120 origin requests per minute. This includes signed-in heatmap reads: those responses contain personal data and are not CDN-cached, but the route remains publicly reachable and therefore uses the same IP budget. If real traffic shows busy gyms hitting the ceiling, adjust the documented policy deliberately rather than adding a route-specific bypass that would reopen aggregate scraping.

## Code map

- `packages/shared/rate-limit` — bounded local limiter, normalized IPs, Redis Lua/key logic, and structured limit error.
- `packages/web/app/lib/public-api-rate-limit.server.ts` — Vercel identity, aggregate policy, and `429` response.
- `packages/web/app/lib/public-api-rate-limit-redis.server.ts` — Vercel Redis connection, timeouts, and circuit breaker.
- `packages/backend/src/utils/redis-rate-limiter.ts` — backend adapter using the same shared Redis core.
