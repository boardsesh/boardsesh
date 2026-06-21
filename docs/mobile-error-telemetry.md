# Mobile error telemetry (PostHog)

The RN app (`packages/mobile`) has no Sentry — PostHog is the only error sink. So
every error a user actually hits must be reported, or it's invisible. Two layers:

## What's automatic

`src/lib/posthog-client.ts` configures PostHog `errorTracking.autocapture` for
**uncaught exceptions** and **unhandled promise rejections**, plus a global
`ErrorUtils` handler (`global-error-capture.ts`) and the Expo Router
`ErrorBoundary` (`app/_layout.tsx`). Crashes and render errors land in PostHog as
`$exception` events with no extra work.

## What you must do: report _handled_ errors

The blind spot is errors the app **catches** and turns into a toast, inline
message, degraded state, or silent `console.warn`. Those never reach autocapture.
Rule of thumb: **every catch that handles a user-affecting failure reports it.**

Use the helpers in `src/lib/error-reporting.ts`:

- `reportHandledError(error, { tags: { source, ... }, extra })` — the default.
  Drops cancellations (`AbortError` / TanStack `CancelledError`) and downgrades
  offline/network failures to a `warning` tagged `network: true`, so error
  tracking stays signal-rich. Use it in catch blocks, GraphQL-WS handlers, and the
  React Query caches.
- `reportError(error, { level, tags, extra })` — raw passthrough. Use only when
  the caller already owns the severity (e.g. auth: a 401 is an `error`, a network
  blip is a `warning`).

Always pass a `tags.source` (and an `op` where it helps) so events group in
PostHog: `react-query`, `native-auth`, `queue-mutation`, `queue-sync`,
`auth-refresh`, `ble-send`, `ble-connect`, `playlist`, `wall-control`, etc.

### Where it's already wired

- **React Query** (`providers/query-provider.tsx`) — `QueryCache` / `MutationCache`
  `onError` report every query/mutation failure once `retry` is exhausted. This is
  the chokepoint for API / GraphQL-HTTP / REST failures; don't re-report at
  individual `useQuery`/`useMutation` call sites. Known gap: a query that keeps
  failing for a non-network reason re-reports on each refetch (focus / remount /
  reconnect) — same `queryHash`, so it groups, but watch event volume in PostHog
  after rollout; add short-TTL dedup keyed on `queryHash` if it's noisy.
- Direct **GraphQL-WS** ops (`@boardsesh/queue-react`, `@boardsesh/playlists-react`)
  bypass React Query, so their catch sites report explicitly.

### What NOT to report (avoid noise)

- Cancellations and expected-empty paths (e.g. a parser returning `null` for a URL
  that isn't a deep link).
- Best-effort key/value store reads/writes whose failure is invisible and
  self-recovering — search filters, recents, image cache, preferences
  (`last-search-store`, `recent-filter-store`, `session-store`, …). Exception: a
  store write that loses a **pending user action** is reported — the deep-link /
  share-target stashes, where a dropped `AsyncStorage.setItem` silently loses a
  tapped invite link or a shared video after login.
- Rate-limit responses — that's expected user pacing, not a bug.
- `__DEV__`-only diagnostics (keep the `console.warn`; report only if the failure
  is user-affecting in production too).

## Verifying

`isAnalyticsEnabled = !!apiKey && !__DEV__`, so **local Metro dev sends nothing**.
Verify on a preview / TestFlight / production build: trigger the failure, then look
for the `$exception` in PostHog filtered by `source`.
