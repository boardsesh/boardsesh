# Analytics consent

Boardsesh asks before it runs product analytics, on the web and in the app,
and stores the answer on the device and on the account. Tracking issue #2644.
This page covers the shared model and the backend half (PR A). The web banner
and privacy policy (PR B) and the app's privacy step (PR C) build on it.

## The record

`@boardsesh/consent` (`packages/shared/consent/`) is the one definition web,
mobile and the backend share:

```ts
type ConsentRecord = {
  analytics: 'granted' | 'denied';
  version: number; // CONSENT_VERSION the climber was asked under
  decidedAt: string; // ISO 8601
  source: 'web' | 'ios' | 'android';
};
```

- `CONSENT_VERSION` is 1. Bumping it makes every stored answer count as no
  answer, so everyone is asked again.
- `needsPrompt(record)` is true when there is no current answer.
  `isAnalyticsGranted(record)` is true only for a current "Allow". No answer
  means no tracking.
- On the web the device copy is the `boardsesh-consent` cookie, value
  `v1.granted.1767225600.web` (version, choice, epoch seconds, source).
  `parseConsentCookieValue` returns null for anything else, so a garbled cookie
  asks again; it can never turn tracking on.

## The merge rule

`resolveConsent(local, server)` merges the device's answer with the account's:

1. A record older than `CONSENT_VERSION` counts as no answer.
2. An account `denied` always wins. "No thanks" anywhere you are signed in
   stops tracking everywhere you are signed in.
3. An account `granted` only applies to a device with no answer of its own. A
   device that said "No thanks" keeps saying it.
4. Otherwise the device's own answer stands.

Because rule 2 lets the account override a newer device grant, a client must
push a new decision with `setAnalyticsConsent` before it next resolves against
the server.

## The account copy

`user_analytics_consent_events` (migration 0261) is append-only. The newest row
per user is the current answer; the older rows are the record of when consent
was given and withdrawn (GDPR Art. 7(1)). It is not a column on
`user_profiles`: a profile row is not guaranteed to exist, and its
`updated_at` feeds the setter sitemap's `lastmod`. Rows cascade away with the
user on account deletion.

GraphQL (`packages/shared-schema/src/schema/analytics-consent.ts`, client
operations in `@boardsesh/graphql/operations/analytics-consent`):

- `myAnalyticsConsent: AnalyticsConsent` is the newest row, or null when the
  climber never answered. Signed-in only.
- `setAnalyticsConsent(input: { analytics, version, source, basedOnDecidedAt })`
  appends a row and returns the account's current answer.
  - The server stamps `decided_at`; a client clock is never trusted. The stamp
    is whole milliseconds and at least 1 ms after the user's previous row, so
    the ISO string a client echoes back names exactly one row.
  - A **denial is always written**.
  - A **grant is compare-and-set**: if the account holds a newer answer than
    `basedOnDecidedAt` (or any different answer when `basedOnDecidedAt` is
    null), nothing is written and the newer answer comes back. This stops a
    device that last synced before "No thanks" elsewhere from turning tracking
    back on.
  - Writes for one user run under a transaction-scoped advisory lock, so a
    racing grant and denial always end denied.
  - Rate limited to 20 a minute per user.

## Legal basis per tracker

| Tracker | Basis | Notes |
| --- | --- | --- |
| PostHog capture and identify (web, app) | Consent | Only after "Allow" (PRs B and C). Feature flags still resolve without consent. |
| PostHog session replay | Consent | Off unless analytics is granted. |
| EAS Observe | Consent | Dispatch only when granted. |
| Android install-referrer attribution | Consent | `Install Attributed` is sent only after a grant. |
| Sentry (web, backend, app) | Legitimate interest | `sendDefaultPii: false`: no IP address, IP headers or request bodies. The backend only ever sets a bare user id, on one GitHub-mirror event. |
| Backend PostHog events | Legitimate interest | Operational telemetry, non-personal by construction (below). |
| First-party active users | Legitimate interest | Our own service statistic; counts leave the database, user ids never do (below). |
| OTA health ping | Legitimate interest | Anonymous, per launch (PR C). |

## Backend PostHog events are non-personal

`captureBackendEvent` (`packages/backend/src/services/analytics/posthog.ts`)
takes no distinct id. Every event gets its own random one,
`backend:<event>:<uuid>`, or a fixed `system:` id for an aggregate event. Every
event carries `$process_person_profile: false`, and property names that carry
identity (`userId`, `email`, ...) are dropped. So these events are sent
whatever a climber's consent and still identify nobody. Live Activity events
and `Tick Climb Not In Catalog` no longer carry a user id; count distinct
`climbUuid` for the latter.

## First-party active users

`user_activity_days` holds one row per signed-in climber per UTC day per
platform. It is how MAU survives opt-outs.

- **Write path.** The backend's authenticated request path:
  `buildHttpConnectionContext` (HTTP) and the graphql-ws `onConnect` and
  per-operation `context` (WebSocket) call `recordUserActivity`
  (`packages/backend/src/services/user-activity.ts`). It is fire-and-forget and
  never throws. An in-process set remembers `userId:day:platform` (cleared when
  the UTC day changes, capped at 50,000 keys), and the insert is
  `ON CONFLICT DO NOTHING`.
- **Write rate.** At most one INSERT per climber per UTC day per platform per
  backend replica. With two replicas and about 1.1 platforms per climber, 10,000
  daily climbers would mean at most about 22,000 INSERTs a day, one every four
  seconds. The table holds about 1.1 rows per active climber per day, so about
  400 × DAU rows at the 13-month cap. It is not a write-hot table in the
  [postgres-query-costs](./postgres-query-costs.md) sense.
- **Platform.** HTTP clients send `x-boardsesh-platform: web|ios|android`;
  graphql-ws clients send `clientPlatform` in `connection_init` (browsers can't
  set headers on a WebSocket upgrade). Anything else is counted as `unknown`.
  The constants are `CLIENT_PLATFORM_HEADER` and
  `CLIENT_PLATFORM_CONNECTION_PARAM` in `@boardsesh/shared-schema`. Backend CORS
  allows the header. Until PRs B and C send it, every row is `unknown`.
- **Snapshot.** The scheduler's `snapshot-active-users` job (00:20 UTC) calls
  the cron-only `snapshotActiveUsers` mutation. It counts yesterday's DAU and
  the trailing 7-day WAU and 30-day MAU, overall and per platform, and sends
  PostHog one `Active Users Snapshot` event on `system:active-users`, dated to
  the counted day, with a uuid derived from the day so a re-run collapses into
  the first copy. Properties: `day`, `dailyActiveUsers`, `weeklyActiveUsers`,
  `monthlyActiveUsers`, and the same per platform (`dailyActiveUsersIos`,
  `monthlyActiveUsersWeb`, ...). Counts only.
- **Retention.** The scheduler's `purge-user-activity` job (07:30 UTC) calls
  `purgeExpiredUserActivity`, which deletes rows older than 13 months.
- **Known gap.** A signed-out climber who declines can't be deduplicated
  without storing an identifier, so they are not in MAU.

Manual runs: `scheduler run snapshot-active-users`, or POST to the backend
`/graphql` with `Authorization: Bearer $CRON_SECRET`:

```json
{"query":"mutation { snapshotActiveUsers { day dailyActiveUsers weeklyActiveUsers monthlyActiveUsers captured } }"}
```
