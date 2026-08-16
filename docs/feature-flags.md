# Feature flags

Two kinds, and they fail in different ways.

**Client flags** (`FEATURE_FLAG_KEYS` in `packages/web/app/flags.ts`) resolve in the browser via `FeatureFlagsProvider`. They hide a control. If PostHog is slow or unreachable the control stays hidden and nothing else happens.

**Server flags** (`SERVER_FEATURE_FLAG_KEYS`) resolve during SSR via `getServerFeatureFlag` and decide whether a route renders at all. `gyms-directory` is the only one today: with it off, `/gyms` and its three facet routes are a plain `notFound()`. A client-resolved flag could not do this — by the time the browser knows the answer the HTML has already shipped.

## How a server flag resolves

`packages/web/app/lib/feature-flags/server-feature-flag.ts`, in order:

1. `FEATURE_FLAG_OVERRIDES` — wins over everything, including the dashboard.
2. No PostHog project key in the environment → off.
3. No distinct id (signed out, and the caller did not pass `allowAnonymous`) → off.
4. `POST {POSTHOG_HOST}/flags/?v=2` under a 1.5s deadline, cached 60s per flag+person.
5. Anything that throws, times out, or comes back unparseable → off.

It fails **closed**: a flag exists because the surface is not ready for everyone, so an unreachable PostHog must not open the gate.

Every step returns a `reason` alongside the boolean, because failing closed and failing silently are not the same thing:

| reason                                 | what it means                                                                                                                                                              |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `override`                             | `FEATURE_FLAG_OVERRIDES` decided it, ON or OFF                                                                                                                             |
| `no-api-key`                           | no `POSTHOG_PROJECT_KEY` / `NEXT_PUBLIC_POSTHOG_KEY` in the runtime env                                                                                                    |
| `no-distinct-id`                       | nobody signed in and the caller did not pass `allowAnonymous`                                                                                                              |
| `posthog-enabled` / `posthog-disabled` | PostHog evaluated the flag. The gate is working                                                                                                                            |
| `flag-missing`                         | 200 OK, flag not in the payload — the key does not exist in the project this api key belongs to. A typo, a renamed or deleted flag, or a key pointing at the wrong project |
| `quota-limited`                        | PostHog has stopped serving flags for the project                                                                                                                          |
| `http-error` / `request-failed`        | non-2xx, timeout, or unparseable body                                                                                                                                      |

The bottom four are "the gate is broken", not "the gate is closed", and each sends one Sentry warning per key per outage — a flag that starts failing fails on every request, so the key latches after the first message and re-arms as soon as PostHog answers again. Repeated warnings for one key therefore mean it recovered and broke again, not that it is noisy.

## The dashboard says 100% and the page still 404s

Ask production. Signed in as a global admin, open:

```
https://www.boardsesh.com/api/internal/feature-flags
```

It is a normal session-cookie-authenticated GET, so the browser you are already signed in with is enough. `?key=<flag>` narrows it to one flag (any key, not only the registered ones — that is how you check whether the dashboard renamed it); with no key it covers every server flag.

Per flag it reports a 2x2 — cached vs live, signed-out visitor vs you:

- `cached.public` — the entry an anonymous request to the gated route used. **This is the one that 404'd the visitor.**
- `cached.viewer` — the entry your own request to that route used
- `live.public` — an uncached probe as a signed-out visitor (what a crawler gets)
- `live.viewer` — an uncached probe as you

Both halves matter because the cache is keyed per flag **and** per person, so your answer says nothing about theirs. The two `live` probes are uncached, so one request costs 2 PostHog calls per flag (each capped at 1.5s) — negligible for today's single server flag, worth a thought before `SERVER_FEATURE_FLAG_KEYS` grows long enough that an admin page load fans out dozens.

Read it like this:

- `cached.public` off but `live.public` on → the 60s data cache has not caught up. Wait a minute and reload twice; the first request after expiry still serves the stale answer while it revalidates.
- `live.public` off but `live.viewer` on → the rollout is still person-targeted. A condition matching an email or a cohort cannot match `anonymous-web-visitor`, the single distinct id every signed-out visitor shares. A public launch needs a plain percentage rollout, not 100% of a filtered set.
- `live.public.reason` is `flag-missing` → the flag key and the project key disagree. Check `config.apiKeySource` and that the flag exists in PostHog project 412845 under exactly that name.
- `live.public.reason` is `no-api-key` → the Vercel runtime env has no PostHog key. Every server flag is off, whatever the dashboard says.
- `config.overrides` names the flag → an env override is deciding it, and the dashboard is not being consulted at all.

## The override lever

`FEATURE_FLAG_OVERRIDES` is a comma-separated list, `gyms-directory` (forces ON) or `gyms-directory=false` (forces OFF).

Locally it is the only way in: the browser PostHog client refuses to initialise off a production hostname, so on localhost there is no person and nothing to evaluate against.

In production it is the kill switch and the "I need this reachable now" lever — set it in the Vercel production environment and redeploy. It short-circuits before any network call, so it also keeps a flagged surface up during a PostHog outage. It outranks the dashboard silently, which is why the diagnostics endpoint always reports it.

## Adding a server flag

1. Export the key from `packages/web/app/flags.ts` and add it to `SERVER_FEATURE_FLAG_KEYS` (not `FEATURE_FLAG_KEYS` — the browser provider would fetch a flag no client component reads).
2. Gate the route with `getServerFeatureFlag(KEY, { distinctId, allowAnonymous })`.
3. Pass `allowAnonymous: true` for anything that must eventually be public. Without it a null distinct id short-circuits to off, so the surface stays signed-in-only however the dashboard is configured, and flipping the rollout to 100% changes nothing for visitors or crawlers.
4. Ship `noindex` while the flag is on: a surface that 404s for half its visitors must not be in the index.
