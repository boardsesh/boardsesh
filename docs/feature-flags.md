# Feature flags

Two kinds, and they fail in different ways.

**Client flags** (`FEATURE_FLAG_KEYS` in `packages/web/app/flags.ts`) resolve in the browser via `FeatureFlagsProvider`. They hide a control. If PostHog is slow or unreachable the control stays hidden and nothing else happens.

**Kill switches invert that default, deliberately.** A flag named `*-kill` gates a shipped feature and an unresolved read means _not killed_, i.e. the feature is on — the opposite of the rule above. The reason is the same asynchrony: a positive flag reads as OFF for the first frames of a cold open, which for a surface whose off-state is a redirect means the visitor watches a redirect flash before the flag lands. `anonymous-climb-view-kill` (mobile, `useAnonymousClimbViewEnabled`) is the worked example — its off-state is the login wall the feature exists to remove, so a flash of it on arrival would defeat the whole surface. Read a kill switch as `useFeatureFlag(key) !== true`, never `=== false`, so a missing key and an unresolved one both mean on.

**Server flags** (`SERVER_FEATURE_FLAG_KEYS`) resolve during SSR via `getServerFeatureFlag` and decide whether a route renders at all — with one off, its route is a plain `notFound()`. A client-resolved flag could not do this: by the time the browser knows the answer the HTML has already shipped.

`cnc-packs` is the registry's only entry today, and the first one resolved with `allowAnonymous: true` — build packs are bought by people who have never signed in, so a gate that only evaluated for a session would keep `/build-plans` signed-in-only however the dashboard is configured. (`gyms-directory` was the previous occupant; `/gyms` and its three facet routes now render for everyone and that flag is gone.)

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

It is a normal session-cookie-authenticated GET, so the browser you are already signed in with is enough. `?key=<flag>` asks about one flag — any key, not only the registered ones, which is how you check whether the dashboard renamed it. With no key it covers every registered server flag, which while `SERVER_FEATURE_FLAG_KEYS` is empty means `?key=` is the only useful form.

Per flag it reports a 2x2 — cached vs live, signed-out visitor vs you:

- `cached.public` — the entry an anonymous request to the gated route used. **This is the one that 404'd the visitor.**
- `cached.viewer` — the entry your own request to that route used
- `live.public` — an uncached probe as a signed-out visitor (what a crawler gets)
- `live.viewer` — an uncached probe as you

Both halves matter because the cache is keyed per flag **and** per person, so your answer says nothing about theirs. The two `live` probes are uncached, so one request costs 2 PostHog calls per flag (each capped at 1.5s) — negligible at today's handful of keys, worth a thought before `SERVER_FEATURE_FLAG_KEYS` grows long enough that an admin page load fans out dozens.

Read it like this:

- `cached.public` off but `live.public` on → the 60s data cache has not caught up. Wait a minute and reload twice; the first request after expiry still serves the stale answer while it revalidates.
- `live.public` off but `live.viewer` on → the rollout is still person-targeted. A condition matching an email or a cohort cannot match `anonymous-web-visitor`, the single distinct id every signed-out visitor shares. A public launch needs a plain percentage rollout, not 100% of a filtered set.
- `live.public.reason` is `flag-missing` → the flag key and the project key disagree. Check `config.apiKeySource` and that the flag exists in PostHog project 412845 under exactly that name.
- `live.public.reason` is `no-api-key` → the Vercel runtime env has no PostHog key. Every server flag is off, whatever the dashboard says.
- `config.overrides` names the flag → an env override is deciding it, and the dashboard is not being consulted at all.

## The override lever

`FEATURE_FLAG_OVERRIDES` is a comma-separated list, `some-flag` (forces ON) or `some-flag=false` (forces OFF).

Locally it is the only way in: the browser PostHog client refuses to initialise off a production hostname, so on localhost there is no person and nothing to evaluate against.

In production it is the kill switch and the "I need this reachable now" lever — set it in the Vercel production environment and redeploy. It short-circuits before any network call, so it also keeps a flagged surface up during a PostHog outage. It outranks the dashboard silently, which is why the diagnostics endpoint always reports it.

## Adding a server flag

1. Export the key from `packages/web/app/flags.ts` and add it to `SERVER_FEATURE_FLAG_KEYS` (not `FEATURE_FLAG_KEYS` — the browser provider would fetch a flag no client component reads).
2. Gate the route with `getServerFeatureFlag(KEY, { distinctId, allowAnonymous })`.
3. Pass `allowAnonymous: true` for anything that must eventually be public. Without it a null distinct id short-circuits to off, so the surface stays signed-in-only however the dashboard is configured, and flipping the rollout to 100% changes nothing for visitors or crawlers.
4. Ship `noindex` while the flag is on: a surface that 404s for half its visitors must not be in the index.

## Retiring a server flag

When the surface launches for everyone, delete the gate rather than pinning the
dashboard to 100%: a flag left at 100% is still a PostHog round trip in front of
every render, and still fails closed when PostHog does.

1. Drop the `getServerFeatureFlag` call and the `notFound()` it guarded. Check
   what else used the `getPosthogDistinctId` read feeding it before deleting
   that too — on the directory it also settled the claim call-out's viewer
   state, so it stayed and only moved into the page's existing `Promise.all`.
2. Remove the key from `packages/web/app/flags.ts` and `SERVER_FEATURE_FLAG_KEYS`.
3. Rewrite the gate's tests as "this route renders" rather than deleting them —
   an unconditional surface still has to be reachable on every facet it claims.
4. Archive the flag in the PostHog dashboard; nothing reads it any more.
5. Revisit the `noindex` from step 4 above, but only on its own merits. The
   directory kept its `noindex` past its launch because the reason for it was the
   duplicate-gym queue, not the flag.

## Mobile flags

Mobile has its own catalog and its own provider — none of the web machinery above
(server flags, `FEATURE_FLAG_OVERRIDES`, the `/api/internal/feature-flags`
diagnostic) applies on native. The whole surface lives in three files:

- **Catalog**: `FEATURE_FLAG_DEFINITIONS` in
  `packages/mobile/src/providers/feature-flags-provider.tsx` — `{ key, label,
  description, variants? }`. Add a flag once here and it shows up in the live
  PostHog read AND the tester-only Feature Flags screen (More → Feature Flags).
  Two of them steer telemetry rather than UI: `observe-dispatch-enabled` is the
  kill switch for expo-observe, and `observe-sample-rate` is the live
  multivariate flag carrying its sample rate. Both are read in
  `packages/mobile/src/hooks/use-observe-runtime-config.ts`; see
  `docs/mobile-ota-updates.md`.
- **Live read**: `readPosthogFeatureFlags` in `packages/mobile/src/lib/analytics.ts`.
- **Dev override**: `packages/mobile/src/lib/feature-flag-overrides.ts` — an
  on-device `Record<string, boolean | string>`, persisted to AsyncStorage,
  settable from the Feature Flags screen.

**Precedence, low to high**: PostHog < a static `flags` prop (build-time /
emergency override) < the on-device dev override. `FeatureFlagsProvider`
(`packages/mobile/src/providers/feature-flags-provider.tsx`) merges all three
into one `FeatureFlags` bag every consumer reads from.

**Unresolved reads as the shipped default, never a flash.** PostHog resolves
asynchronously on a cold start, so a flag with no value yet is indistinguishable
from a flag that will never resolve (no network, ad-blocker, dev build with no
key). Every flag in the catalog — boolean or multivariate — must pick a
direction where "not yet answered" and "off" (or "the un-flagged variant") are
the same rendered UI. `useAnonymousClimbViewEnabled`'s kill-switch inversion
above is the sharpest example of this rule; the two render-mode flags below are
a plainer one — the shipped defaults ARE the unresolved reading, so there is
nothing to invert.

### Boolean vs multivariate

Most flags are plain on/off: `FeatureFlags[key]` is `boolean | undefined`, read
with `useFeatureFlag(key)` (`=== true`, or `!== true` for a kill switch).

A flag with a `variants: readonly string[]` list on its definition is
**multivariate** — PostHog resolves it to one of those strings instead of a
boolean. Read it with `useFeatureFlag(key)`, which returns
`boolean | string | undefined`, and narrow it yourself; there is no
`useFeatureFlagVariant` helper (an earlier version of this doc described one
that never came back after 2.4). The narrowing that matters happens before the
hook, in the coercion below: anything that is NOT a declared member — a boolean
read (a build that predates the variant, or a flag PostHog says `false` for
because it matched nothing), an unknown string, or an unresolved read — never
reaches the bag at all. A missing key always means "fall back to the shipped
default", the same contract every boolean flag follows.

> **The multivariate path is only as alive as its last consumer.** It was
> deleted wholesale for 2.4 when the last two variant flags were retired — the
> `variants` property, the coercion branch, and the read helper — while this doc
> and several comments went on describing it. `observe-sample-rate` restored the
> first two in #5038. If you retire the last multivariate flag again, update this
> section in the same change rather than leaving it describing a path that no
> longer exists.

The coercion happens once, in `readPosthogFeatureFlags` /
`coerceFeatureFlagValue` (`packages/mobile/src/lib/analytics.ts`): pass the
flag's `variants` and only a declared member survives the read; omit it for a
plain boolean flag and the behaviour is byte-identical to before multivariate
flags existed. The on-device override widens the same way — `setOverride(key,
value)` accepts `boolean | string`, and the Feature Flags screen renders a
`select`-style row (Default + each declared variant) instead of the boolean
On/Off segmented control whenever a definition has `variants`.

### The board-render flags (issue #2202) — both retired

Neither `board-render-mode-default` nor `board-glow-falloff` exists any more.
They gated the 2.4 rollout of the Aura drawing and A/B'd its glow curve;
2.4 ships that drawing as the app default and every knob as a climber-facing
setting under **More > Board look**, so there is nothing left for a flag to
decide. `requestedBoardRenderMode` answers `'aura'` for a stored
`mode: 'default'`, and a `default` glow falloff resolves to `soft`.

What still gates the drawing is not a flag: the native capability probe. An
installed binary that cannot draw the Aura mode is forced to `classic` by
`resolveEffectiveRenderSettings`
(`packages/mobile/src/lib/board-render-settings.ts`), and that is now the only
thing standing between an older build and a drawing it cannot produce.

They were also the last two **multivariate** flags, and their removal took the
whole path with them: `useFeatureFlagVariant`, the variant row rendering, the
coercion branch and the `variants` field on a definition.

`observe-sample-rate` (#5038) brought back the two pieces a live flag actually
needs — `variants` on the definition, and the coercion branch that lets a
declared member survive `readPosthogFeatureFlags`. **The tester screen was not
rebuilt.** `buildFeatureFlagRows` and `FeatureFlagOverrideAction`
(`packages/mobile/src/components/feature-flag-rows.ts`) are still boolean-only,
so a multivariate flag renders there as On/Off and an on-device override can
only write a boolean. For `observe-sample-rate` that is harmless — a boolean
parses back to the shipped rate — but it does mean **the sample rate can only be
changed from the PostHog dashboard, not from the device.** Rebuild the row
rendering if a future flag needs on-device variant selection.

Full event contract, the PostHog dashboard setup (both flags plus the
Experiment), and the stratification rule for reading the results:
`docs/board-render-analytics.md`.
