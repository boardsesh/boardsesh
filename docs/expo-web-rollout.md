# Expo-web rollout

How logged-in web visitors get moved onto the `/app` Expo-web SPA, one surface
at a time, behind a PostHog flag — and how to turn it off instantly.

This is the rollout layer on top of the `/app` serving work
(`docs/expo-web-deployment.md`). Serving `/app` is a prerequisite; this doc
covers only the flag-gated redirect that sends classic web surfaces there.

## The flag

- **Key:** `expo-web-app`
- **PostHog id:** 767179 (project 412845)
- Starts **inactive / 0% rollout**. While it is off (or a visitor is outside the
  rollout cohort), nothing changes — the classic web UI renders.

The web app evaluates PostHog flags **only on the client** (posthog-js-lite, via
`FeatureFlagsProvider`). Middleware runs on the edge and cannot call PostHog, so
we bridge the flag to a cookie:

1. `ExpoWebRolloutCookieSync` (mounted in `app/layout.tsx` inside
   `FeatureFlagsProvider`) reads the resolved `expo-web-app` value and mirrors it
   into the non-HttpOnly `bs_expo_web` cookie (`1` when on, cleared when off).
   The on-value has a **4-hour TTL**, refreshed on every classic-side
   navigation — see Rollback for why it is short.
2. `middleware.ts` reads `bs_expo_web` on the edge and redirects matching
   surfaces.

Because the cookie is written client-side after the flag resolves, the **first**
navigation after login always stays classic (no cookie yet); the redirect kicks
in on the next navigation. That lag is deliberate — the safe default is classic.

## The redirect map

`mapToExpoWebTarget` (`app/lib/expo-web-rollout.ts`) is the single source of
truth. The `/app` SPA is client-routed (`baseUrl: '/app'`, web output `single`),
so a plain path redirect resolves to `index.html` and Expo Router takes over.
Locale prefixes (`/es/…`, `/fr/…`) are stripped — `/app` is locale-neutral.

The map only emits URLs the SPA genuinely handles today — no redirect may land
on a broken screen:

| Classic web surface                                                                | Redirects to         | Board context carried                     |
| ---------------------------------------------------------------------------------- | -------------------- | ----------------------------------------- |
| `/[board]/[layout]/[size]/[sets]/[angle]/list` (numeric or named segments)         | `/app/climbs`        | none (see below)                          |
| `/b/[slug]/[angle]/list`                                                           | `/app/climbs`        | none (see below)                          |
| `/[board]/[layout]/[size]/[sets]/[angle]/view/[uuid]` — **fully-numeric IDs only** | `/app/climbs/[uuid]` | `?boardName&layoutId&sizeId&setIds&angle` |
| `/[board]/[layout]/[size]/[sets]/[angle]/view/[uuid]` — named segments             | stays classic        | —                                         |
| `/b/[slug]/[angle]/view/[uuid]`                                                    | stays classic        | —                                         |

`/app/climbs/[uuid]` is the Expo Router **ClimbDetail** route, the native app's
own deep-link target for a climb — it opens the play drawer. It reads exactly
`boardName`/`layoutId`/`sizeId`/`setIds`/`angle` and `Number(...)`s the IDs, so
only the fully-numeric legacy form redirects there. The canonical named-segment
form (what `constructClimbViewUrlWithSlugs` emits) and the `/b/[slug]` form stay
classic until the SPA can resolve name slugs — redirecting them today would
dead-end on a not-found screen.

The list redirect carries **no board context**: the Climbs tab
(`packages/mobile/app/(tabs)/climbs/index.tsx`) takes its board from the
visitor's persisted active board and reads no board search params, so a flagged
visitor following a shared list link lands on _their_ active board. That loss is
deliberate and bounded — carrying the link's board requires SPA-side support
first.

A classic board URL with a query string (`?minGrade=…`, `?name=…`, `?sortBy=…`)
never redirects: the SPA does not read filter state from the URL, so shared
filtered links are served classic instead of silently dropping the filters.

Everything else stays classic: board create/queue pages, profiles, playlists,
gyms, setters, API routes, and the homepage all return `null` from the map.

## The three gates (off in every dimension by default)

The redirect fires only when **all** hold:

1. `BOARDSESH_WEB=1` — the site is built with the `/app` surface available
   (`isExpoWebRolloutEnabled()`). Production static-export builds set this; a
   plain classic build does not.
2. `bs_expo_web=1` cookie — the visitor's `expo-web-app` flag resolved true.
3. A next-auth session cookie — the visitor is logged in. Logged-out visitors
   and crawlers (no session cookie) never redirect, so public/SEO board views
   stay canonical.

Login is detected by cookie **presence** (`__Secure-next-auth.session-token` or
`next-auth.session-token`), the same heuristic as `getServerAuthToken`. The edge
does not verify the JWT; a stale cookie at worst lands the visitor on the SPA,
which does its own auth.

## Escape hatch: back to classic

A user (or a bug report) can always force classic:

- `?classic=1` on any URL — middleware strips the param, 307s to the clean
  classic URL, and pins the `bs_classic` cookie (one year). From then on the
  cookie alone forces classic on every page.
- The `bs_classic` cookie short-circuits the redirect while it is present.

There is no UI affordance yet; `?classic=1` is the documented lever.

## Rolling out

1. Confirm the `/app` export is deployed and healthy (`docs/expo-web-deployment.md`).
2. In PostHog, activate `expo-web-app` (id 767179) and dial the rollout
   percentage up gradually (start with an internal cohort / small %).
3. Watch: do flagged users land on `/app/climbs` and `/app/climbs/[uuid]`
   correctly (board resolves, climb opens in the play drawer)? Named-segment
   and `/b/[slug]` climb-view URLs stay classic by design — widening them into
   the map requires SPA-side slug resolution first.

## Rollback

- **Flag off, no deploy:** set `expo-web-app` to 0% in PostHog. Visitors who
  load any classic page clear `bs_expo_web` immediately. Visitors who live
  entirely inside `/app` (the SPA never touches the cookie) are covered by the
  cookie's 4-hour TTL: it expires, their next migrated-surface hit falls
  through to classic, and the classic page re-evaluates the flag. Worst-case
  rollback lag is therefore the TTL, not the cookie lifetime.
- **Per-user:** `?classic=1` (see the escape hatch above) — works immediately,
  even inside the TTL window.
- **Whole build:** ship without `BOARDSESH_WEB=1` — gate 1 fails and the
  rollout is inert regardless of flag or cookie state.
