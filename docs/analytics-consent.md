# Analytics consent

Boardsesh asks before it runs product analytics, on the web and in the app,
and stores the answer on the device and on the account. Tracking issue #2644.
This page covers the shared consent model, account synchronization, backend
statistics, web banner and privacy policy. The app shares the model and account
synchronizer.

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

`user_analytics_consent_events` (migration 0262) is append-only. The newest row
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
  - A **grant is compare-and-set**: `basedOnDecidedAt` must exactly equal the
    canonical ISO millisecond stamp of the latest account answer. A null stamp
    is accepted only when there is no answer or the current answer is already
    granted. Otherwise nothing is written and the current answer comes back. This stops a
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
| Sentry (web, backend, app) | Legitimate interest | `sendDefaultPii: false`, with explicit identity/request-field redaction. User identifiers are removed from the GitHub mirror too. |
| Backend PostHog events | Legitimate interest | Operational telemetry, non-personal by construction (below). |
| First-party active users | Legitimate interest | Our own service statistic; counts leave the database, user ids never do (below). |
| OTA health ping | Legitimate interest | Anonymous, per launch (PR C). |

## Backend PostHog events are non-personal

`captureBackendEvent` (`packages/backend/src/services/analytics/posthog.ts`)
takes no distinct id. Every event gets its own random one,
`backend:<event>:<uuid>`, or a fixed `system:` id for an aggregate event. Every
event carries `$process_person_profile: false`, and named identity and session properties (`userId`, `email`, `sessionId`,
`boundSessionId`, ...) are dropped. Current callers send operational counts,
outcomes and content identifiers, and omit participant identifiers. New callers
must keep their operational payloads non-personal. So these events are sent
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


## Account synchronization

`createConsentSyncCoordinator` in `@boardsesh/consent` owns the merge and retry
rules for both clients. The platform injects transport and storage. Every server
response belongs to an account epoch; a response from a previous sign-in cannot
change the active account or device. A new decision changes the device choice
immediately, then is persisted as a pending write under that account before the
network request. Offline withdrawals survive restart. Pending decisions are
pushed before old account answers are merged, so changing No thanks to Allow
is not immediately undone by the old account denial.

The coordinator retains the precise last-server `decidedAt` for compare-and-set.
The browser cookie rounds to whole seconds and is never used as a server token.
A pending grant keeps the token from when it was decided; a retry does not fetch
a newer denial and pretend that the old grant was based on it. Reads append
nothing when device and account already agree. Pending records are validated
before storage can restore an analytics grant.

## Website and browser app

The website renders the same banner and analytics components for every request.
A pre-paint script reads the current, valid `boardsesh-consent` cookie and sets
`html[data-consent]`; CSS hides answered banners before hydration. Request
cookies never determine cached HTML. The one-year cookie uses Path=/,
SameSite=Lax and Secure on HTTPS, with Domain=.boardsesh.com on the production
origins. Local development and previews use host-only cookies. The browser app
reads the same cookie through its platform storage adapter. Since browser
broadcast channels do not cross origins, returning to a tab re-reads the cookie
and synchronizes the signed-in account.

The banner offers Allow and No thanks with equal weight and a privacy-policy
link. Privacy choices in the footer reopens it, as does the Analytics settings
card. Embed and kiosk routes do not show a banner. Embeds never send product
analytics. Kiosks send only an operational Kiosk Page Loaded event with a random
ID per event and an allowlist of non-personal properties; they have no SDK
identifier, full URL or referrer.

Website PostHog starts opted out with memory persistence so flags still work.
Signed-in flag evaluation may use the account ID without identify/capture.
Allow replaces the client with a persisted instance and opts in; product
identify is allowed only then. Withdrawal blocks capture and retries immediately,
opts out, discards all four SDK event/log queues, resets identity, opts out again,
and clears old ph_* storage. The retired transport is disabled and pending
requests are aborted before shutdown. `posthog-js-lite` 4.10.4 does not expose a
persistence setter; instance replacement also rebinds every flag subscriber.
`@posthog/core` 1.48.8 preserves queues during reset and flushes buffered events
even while opted out, so optOut plus shutdown alone is insufficient.

An authenticated account must resolve before a stored grant can enable capture;
auth loading and account switches temporarily block product analytics. Every
capture and transport check re-reads the shared cookie, so a background tab
respects a withdrawal from the other origin without waiting for focus.
An external cookie grant blocks capture before notifying SDK subscribers and
requires a fresh consent read for the current authenticated account; the cookie
cannot authorize a different account. Signed-out visitors can accept a shared
grant immediately. Account responses also re-read the cookie before merging so
a delayed grant cannot overwrite a newer withdrawal.
Pageviews, vitals collection and vitals flushing check consent explicitly.
Withdrawing discards the buffered metrics. Reset on sign-out reapplies the
existing device opt state and web super properties. HTTP GraphQL requests send
x-boardsesh-platform: web so signed-in first-party activity remains counted.

The backend PostHog proxy strips client IP and HTTP User-Agent headers from
flags and capture traffic. Granted analytics explicitly supplies its consented
user-agent event property; operational events use minimal payloads.
Functional flag requests retain allowlisted OS, app version/build, namespace,
and device-type properties without analytics consent. The proxy overwrites
GeoIP properties with only a current, edge-verified country and sets
`geoip_disable: true`, so neither the backend location nor stale account GeoIP
can decide region targeting. Unknown or untrusted country resolves as `XX`.
The trust boundary and header prerequisite are in `docs/cloudflare.md`.

Pending consent restoration preserves a newer withdrawal, including equal
timestamps rounded to cookie seconds. A rapid No thanks → Allow rebases its
pending grant only onto its own successful withdrawal; a later withdrawal from
another device still wins the backend comparison. Mobile flag freshness belongs
to the current account and auth generation, so another account's response cannot
remove early-update membership. SDK startup and reset restore current connectivity
and remembered OTA super properties after asynchronous consent initialization.

Consent copy and equal-choice controls follow the [EDPB consent guidelines](https://www.edpb.europa.eu/sites/default/files/files/file1/edpb_guidelines_202005_consent_en.pdf). Declining does not limit the app, and withdrawal uses the same two-choice controls.
