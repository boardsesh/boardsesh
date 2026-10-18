# Analytics consent

Boardsesh asks before it runs product analytics, on the web and in the app,
in the EU, the EEA, the UK, Switzerland, China, South Korea and the other places
listed under [Who is asked](#who-is-asked), and whenever it cannot tell where a
visitor is. Everywhere else analytics starts on and the climber can switch it
off in Settings. Install attribution needs the climber's own Allow everywhere. Answers are stored on the device and on the account. Tracking issue
#2644.
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
  basis?: 'explicit' | 'region_default'; // device-only; absent means explicit
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
  asks again; it can never turn tracking on. A region default adds a fifth
  part, `v1.granted.1767225600.web.region`; only `granted` may carry it.
- `basis` is new and optional, so no `CONSENT_VERSION` bump: every record
  stored before it reads as explicit. A bundle that predates the fifth cookie
  part reads a region-default cookie as no answer and asks, the safe direction.

## Who is asked

`consentPromptRequired(countryCode, regionCode)` in `@boardsesh/consent`
(`packages/shared/consent/src/consent-region.ts`) decides. It is true for:

- The 27 EU member states, plus EU territory that geolocation reports under its
  own code: Åland `AX`, French Guiana `GF`, Guadeloupe `GP`, Saint-Martin `MF`,
  Martinique `MQ`, Réunion `RE`, Mayotte `YT`.
- The rest of the EEA: Iceland `IS`, Liechtenstein `LI`, Norway `NO`.
- The UK `GB`, and places with their own copy of GDPR: Switzerland `CH`
  (revised FADP), Gibraltar `GI`, Guernsey `GG`, Jersey `JE`, Isle of Man `IM`.
  These are a policy choice, kept in their own list so they can be dropped.
- China `CN` (PIPL has no legitimate-interest basis) and South Korea `KR`
  (PIPA is built on consent). Also a policy choice, in a list of their own.
- Every code that does not name one known country: null, `XX`, `ZZ`, Tor's
  `T1`, the other user-assigned codes (`AA`, `QM`-`QZ`, `X*`), the reserved
  `EU` and `UK`, lowercase or malformed values. When in doubt, ask.

The owner also selected Andorra `AD`, Monaco `MC`, San Marino `SM`,
Vatican City `VA`, the Faroe Islands `FO` and Quebec (`CA` plus trusted
province `QC`). Other known Canadian provinces skip the prompt. A missing,
malformed or unknown Canadian province prompts: without it we cannot exclude
Quebec. There is no VPN/device-locale fallback.

**Where the country comes from.** The unauthenticated GraphQL query
`consentRegion { countryCode promptRequired globalPrivacyControl }`. The backend reads Cloudflare's
`CF-IPCountry` through `resolveFlagCountry` (`packages/backend/src/utils/flag-country.ts`),
the same trusted-hop check the PostHog proxy uses (see `docs/cloudflare.md`):
a forged header from a direct-origin caller resolves as `XX` and asks. The HTTP
context carries that coarse country (`ConnectionContext.edgeCountry`) and the
trusted subdivision (`edgeRegionCode`), which the backend uses only for Canada.
The optional native `CF-Region-Code` is ignored: a trusted edge hop alone does
not prove that header was overwritten. The narrow `X-Boardsesh-Region-Code`
header is ignored until the edge overwrite/remove rule has been applied and
`BOARDSESH_TRUST_EDGE_REGION_HEADER=true` is set; see
[Cloudflare deployment order](./cloudflare.md#consent-province-header). Neither is stored; the IP is not read, logged or stored for this. WebSocket operations have no edge
country and always ask. `myAnalyticsConsent` does not carry `promptRequired`:
it is signed-in only and null exactly when the region is needed.

**Region default.** A device with no answer whose region is not a prompt region
takes `createRegionDefaultConsent(source)`: analytics granted, `basis:
'region_default'`. It is device-only:

- It is nobody's answer, so it never carries `ownerAccountId` or
  `basedOnDecidedAt`. `mergeAccountConsent` checks for it before anything else:
  with no account answer the device keeps it and writes nothing; any account
  answer, grant or denial, replaces it with the account's copy. So it is never
  written to the account and never recorded as an Art. 7 consent.
  `parsePendingConsentDecision` refuses one, `decide()` never makes one, and
  `accountCopy` never copies `basis`. `isSameConsentRecord` compares `basis`, so
  a re-read default and an explicit grant from the same second differ.
- Any choice in Settings, the footer's Privacy choices or the prompt replaces it
  with an explicit record that syncs as before.
- It counts as "on" only once this launch or page load looked the region up and
  got `false` (`regionConfirmed` in the app's consent state, the same flag
  behind `hasAnalyticsConsent()` on the website). Before that answer, and when
  the lookup fails, it stays stored but sends nothing, and nothing is asked.
- A prompt region drops it and the prompt asks (a climber who travels into the
  EU). The app refreshes the region on each foreground resume while it holds
  a default; the website refreshes it on focus, becoming visible or coming
  online. Both stop capture synchronously until the new answer confirms a
  non-prompt region. A resume during a pending request queues one fresh lookup
  after it settles; simultaneous signals share that follow-up. The old response
  cannot confirm the region or enable capture. This also applies to the first
  lookup on a device with no answer. Native and web share the queue and reject
  callbacks from a settled answer expired before its UI consumer runs.
- Install attribution (Apple Ads, the Play install referrer) never runs on it.
  See [Legal basis per tracker](#legal-basis-per-tracker).

**Stored apart from answers.** The app keeps the region default under its own
key, `analyticsConsentRegionDefault`. The answer key, `analyticsConsent`, holds
only the climber's own answers, because every bundle before this change reads
that key as an explicit answer it may write to the account. An older bundle can
still run on the device (expo-updates falls back to the embedded bundle after a
crash, or an OTA is rolled back): it finds no answer and asks. This is the
expand-then-contract rule from the offline database, applied to consent
storage. `persistLocalConsent` writes the new key before clearing the other, and
`readLocalConsent` reads the answer key first. On the web the cookie's fifth
part does the same job: every parser before it, including the pre-paint script,
requires exactly four parts, so an older bundle reads a region-default cookie as
no answer and asks.

**Global Privacy Control.** On the website and the browser app, a browser that
sends Global Privacy Control (`navigator.globalPrivacyControl`, or `Sec-GPC: 1`,
which `consentRegion` echoes as `globalPrivacyControl`) gets no region default
outside the prompt regions: no cookie is written, a stored default is dropped,
no banner shows and nothing is tracked. Privacy choices still lets the visitor
allow analytics. Inside the prompt regions the banner asks as usual. The native
app sends no GPC.

**App.** `ConsentGate` (`packages/mobile/src/components/onboarding/ConsentGate.tsx`)
starts the lookup as soon as the device turns out to have no answer
(`lookUpConsentRegion`, one request per launch, capped at 5 seconds). Where it
would open the prompt it waits for that answer: `false` writes the region
default, `true` or no answer opens the prompt. It applies the default at most
once per launch and account; if anything drops it again, the gate settles with
no answer (nothing tracked, no prompt) rather than apply it in a loop. Signed-in
climbers still wait up to 5 seconds for their account answer first; an account
answer is never touched. The gate never starts an account read itself: it runs
again when the sync effect's read lands. Screenshot mode and the
`privacy-consent-step-kill` flag skip the lookup, as they skip the prompt.

**Website.** The browser asks, never the server: list and climb pages are cached
at Cloudflare (`boardsesh:www-html-edge-cache`) and shared between visitors, so a
region decided in middleware or the layout would hand one visitor's country to
another. `useConsentRegionPrompt` (used by the banner) looks the region up once
per page load while the cookie holds no answer or a region default. The banner
renders only after a prompt region or an unknown answer (capped at 5 seconds),
so a visitor outside those regions never sees it flash. A `false` answer writes
the region-default cookie; this is the one consent cookie written without a
click. Kiosk and embed pages never look up the region and never write it. The
lookup is a cross-origin POST, so backend CORS answers its preflight with
`Access-Control-Max-Age: 600`: one OPTIONS per ten minutes, not per page load.

**Legal basis outside the prompt regions.** Product analytics there runs under
legitimate interest with an opt-out: the Analytics toggle in app Settings, and
Privacy choices on the website. Both are global, for every visitor in every
region, and so is the account merge rule. Session replay stays a separate
opt-in that defaults off everywhere. Install attribution needs an explicit
Allow everywhere.

**Location with the region default.** A device on a confirmed region default
captures like one with an Allow, so its capture requests carry the
`x-boardsesh-analytics-consent: granted` header and the PostHog proxy forwards
the edge-reported visitor IP for PostHog's GeoIP (see
[Website and browser app](#website-and-browser-app)). That is the same
legitimate-interest basis as the capture itself. An unconfirmed default sends
no capture at all.

## The merge rule

`resolveConsent(local, server)` merges the device's answer with the account's:

1. A record older than `CONSENT_VERSION` counts as no answer.
2. An account `denied` always wins. "No thanks" anywhere you are signed in
   stops tracking everywhere you are signed in.
3. An account `granted` only applies to a device with no answer of its own, or
   only a region default. A device that said "No thanks" keeps saying it.
4. Otherwise the device's own answer stands.

Because rule 2 lets the account override a newer device grant, a client must
push a new decision with `setAnalyticsConsent` before it next resolves against
the server.

## Whose answer is it

The device copy remembers the account that was signed in when the answer was
given or adopted from the account (`ownerAccountId` on `DeviceConsentRecord`;
the app stores it beside the answer). An answer given signed out has no owner,
and neither has one saved before this field existed. The web cookie never names
an account, so every cookie answer is ownerless. A decision this device made
signed in also keeps `basedOnDecidedAt`, the account answer it was made
against, until the account confirms it; a copy adopted from the account never
has it.

`mergeAccountConsent` applies the merge rule only to an answer this device gave
under the signed-in account. For anything else:

| Device answer (signed out, other account, cookie) | Account answer | Device holds | Written to the account |
| --- | --- | --- | --- |
| region default | none | the region default | nothing |
| region default | Allow or denied | the account's answer | nothing |
| any other | none | nothing: ask again, no tracking until answered | nothing |
| any other | denied | the account's denial | nothing |
| Allow | Allow | the account's Allow | nothing |
| No thanks | Allow | its own No thanks (rule 3) | nothing |

So on a shared phone or browser, one person's signed-out Allow never becomes
another person's recorded consent: the second person is asked after signing in.

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
- `setAnalyticsConsent(input: { analytics, version, source, basedOnDecidedAt, conditional })`
  appends a row and returns the account's current answer. `version` must be
  between 1 and the server's `CONSENT_VERSION`; deploy the backend first when
  bumping it.
  - The server stamps `decided_at`; a client clock is never trusted. The stamp
    is whole milliseconds and at least 1 ms after the user's previous row, so
    the ISO string a client echoes back names exactly one row.
  - A **denial is always written**, unless the client marks it `conditional`.
  - A **grant is compare-and-set**: `basedOnDecidedAt` must exactly equal the
    canonical ISO millisecond stamp of the latest account answer. A null stamp
    is accepted only when there is no answer or the current answer is already
    granted. Otherwise nothing is written and the current answer comes back. This stops a
    device that last synced before "No thanks" elsewhere from turning tracking
    back on.
  - A **`conditional` write is compare-and-set whatever its answer**: it is
    written only while the latest account answer is exactly `basedOnDecidedAt`
    (no answer when null), and otherwise the current answer comes back. Clients
    set it only on a recovered write (see Account synchronization). Older
    clients never send it, so their denials stay unconditional. A backend that
    predates the field rejects the input, so a recovered write stays pending
    until the backend deploys and never lands unconditionally.
  - Writes for one user run under a transaction-scoped advisory lock, so a
    racing grant and explicit denial always end denied.
  - Rate limited to 20 a minute per user.

## Legal basis per tracker

| Tracker | Basis | Notes |
| --- | --- | --- |
| PostHog capture and identify (web, app) | Consent in the prompt regions; legitimate interest with opt-out elsewhere | Only after "Allow" in the prompt regions; on by default elsewhere (region default). Feature flags still resolve without consent. A signed-in No thanks or switch-off (unless the account already said No), and account deletion, erase the PostHog person ([Erasure](#erasure)). |
| Feature-flag bucketing id (web, app) | Strictly necessary (ePrivacy Art. 5(3) exemption), not asked | One random UUID per browser (IndexedDB) or app install (app preferences). Why it is necessary: kill switches and staged rollouts are how we keep the service a climber asked for working, and both need a stable bucket. Without one a 20% rollout re-rolls every launch, so a climber flips between the old and new screen from one launch to the next, and a kill switch scoped to a percentage cannot hold anyone out. It carries no account, no person and no GeoIP, and is never sent next to an account id or beside the SDK's own anonymous id. Lifetime: replaced 13 months after it was minted (CNIL's ceiling for an exempt tracker), and in the app also when the platform reports a different install time (an Android Auto Backup restore). On www it is only the distinct id of signed-out flag requests. In the app it is also the distinct id of the anonymous `OTA Update Status` event (`ota-install:<uuid>`, row below), which is stored. See [feature-flags.md](./feature-flags.md#anonymous-bucketing). |
| PostHog session replay | Consent | Off unless analytics is on and the climber also switches replay on; never on by default. |
| Self-hosted Observe | Legitimate interest | First-party performance/error diagnostics, independent of the analytics choice. Retains SDK installation/session IDs for update health; no account identity is assigned. |
| Android install-referrer attribution | Consent, everywhere | The Play referrer is not even read before the climber's own Allow: reading it is access to information on the device for attribution (ePrivacy Art. 5(3)). Play keeps it for 90 days after install, and the first Allow triggers the read. `Install Attributed` and the install person properties are sent only after the climber's own Allow (`isAttributionPublicationGranted`). The region default does not enable them. |
| iOS Apple Ads attribution | Consent, everywhere | Native token acquisition, the first-party backend exchange with Apple, and campaign-linked PostHog publication require the climber's own current Allow; the region default never enables them. The exchange sends `basis`, and the backend refuses anything but `explicit` (absent, from an older app, reads as explicit). Tokens are never persisted or sent to diagnostics. |
| Sentry (web, backend, app) | Legitimate interest | `sendDefaultPii: false`, with explicit identity/request-field redaction. User identifiers are removed from the GitHub mirror too. |
| Backend PostHog events | Legitimate interest | Operational telemetry, non-personal by construction (below). |
| First-party active users | Legitimate interest | Our own service statistic; counts leave the database, user ids never do (below). |
| OTA health ping | Legitimate interest | Anonymous: one random id per install (`ota-install:<uuid>`, the same id that buckets signed-out flags, with the same 13-month lifetime), no account, no person profile, no GeoIP. Per install so adoption and emergency rates can count phones, not launches. If the app cannot read or persist its install id, install-level health is skipped until storage recovers; the launch-only signed-out flag fallback does not enter these counts. |

## Backend PostHog events are non-personal

The Apple Ads exchange is `exchangeAppleAdsAttribution` on backend GraphQL,
not a backend PostHog capture. Signed-in exchanges re-read account consent
before and after contacting Apple; account denial overrides device Allow.
The app independently checks current consent and the exact verified account's
SDK identity before publishing normalized campaign fields.

One install has one account owner. The app retains a minimal ownership marker
across sign-out and withdrawal to prevent attribution reaching another account.
Withdrawal clears cached campaign fields and cancels pending acquisition,
publication and signup conversions. A later Allow can perform a fresh lookup
for the same owner; it never restores discarded signup conversions. A withdrawn
anonymous attribution attempt is consumed rather than assigned to a later
account. See [Apple campaign reporting](./growth-metrics.md#apple-ads-ios).

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

Live Activity events (and their `... Attribution Gap` twins) carry
`sessionHash` instead of the party-session id, and widget navigation adds
`boundSessionHash`: an HMAC-SHA256 of the id keyed with
`POSTHOG_SESSION_HASH_SALT`, so one session's start, pushes, taps and end can be
joined into a funnel. A plain hash would not do: session ids travel in join
links, and anyone holding one could recompute it. With the salt unset, both
properties are omitted. Rotating the salt breaks joins across the rotation.

## Erasure

PostHog keeps a person per identified climber: the account id as distinct id,
the anonymous ids merged into it at sign-in, `email`, the Apple Ads and
install-referrer properties, their events and their recordings. Two things
erase it.

- **Account deletion.** `deleteAccount` queues the erasure in its own
  transaction, before the user row goes.
- **A No thanks from a signed-in account.** `setAnalyticsConsent` queues it
  when it writes a denial and the account's previous answer was not already a
  denial: a grant (any version), or no answer at all. No answer counts because
  before the consent prompt shipped both clients identified every signed-in
  climber with the account id and sent `email`, so an account whose first
  answer is No thanks can still have a person. One with no person costs a
  `bulk_delete` that finds nothing. A repeated denial queues nothing: the first
  one already did, and nothing was captured since.

### The jobs

Each of those queues two jobs on the `posthog-person-deletion` pg-boss queue
(`packages/backend/src/services/analytics/posthog-person-deletion.ts`), in one
savepoint of the caller's transaction, so they exist exactly when the deletion
or withdrawal commits. The PostHog calls never run inside that transaction.

| Pass | Starts | Why |
| --- | --- | --- |
| `first` | 15 minutes after the commit | PostHog deletes only events captured before the request. The wait lets the app's on-disk event queue flush on its next foreground and ingestion catch up. |
| `late` | 7 days after the commit | Catches what still arrived: another signed-in device that had not yet re-read the denial (rule 2 reaches it on its next sync) or had not yet hit a 401 after deletion, and a phone that sat offline with events queued. A deletion PostHog already has queued is not duplicated, so the second call is cheap. |

Each job is the account id, a reason, a pass and, once discovered, the
anonymous ids to erase with it; nothing else.

### What one pass does

Each pass runs in two steps, because the delete erases the very `$identify`
events the lookup reads. Whatever a lookup found is written down before
anything is deleted.

1. **Discover** (the job as queued, no `stage`). One HogQL query
   (`query:read`): every `$identify` the account sent names the anonymous id it
   switched away from as `$anon_distinct_id`. Where PostHog merged that id into
   the account's person, deleting it again is a no-op. Where it refused (the
   split persons in [growth-metrics.md](./growth-metrics.md#identity-split-pitfall),
   161 measured from 2026-09-08 to 10-01), it is the only way to reach the
   pre-sign-in person, which holds that session's `Login Succeeded` and
   `$screen` events. The query also returns every distinct id that identified
   from each anonymous id. An anonymous id that another live account also
   signed in from (a shared phone) is skipped, so erasing one climber never
   erases another. So is an anonymous id that more than 100 distinct ids
   identified from: that is no one climber's device, and the cap keeps the
   account check near 101,000 ids, which it runs 1,000 per query (postgres.js
   refuses a query with 65,534 parameters). The log
   (`posthog_person_deletion_shared_ids_skipped`) has the counts, `shared` and
   `crowded`. Ids that are not accounts, such as the party UUID a signed-out
   install identified as before #6078, belong to the same install and go with
   it. At most 999 anonymous ids, the `bulk_delete` limit less the account id.
   An id longer than 200 characters, or carrying a control character or half
   of a surrogate pair, is dropped: no SDK mints one (they are 36-character
   UUIDs), the capture endpoint takes any `$anon_distinct_id` under the public
   project key, a job cannot carry an over-long id, and PostgreSQL cannot store
   a NUL or half a pair, so one would fail the account check or the persist on
   every retry. The same check drops such an id from the distinct ids that
   identified from an anonymous id: it is no account, so the account check
   never needs it. The log (`posthog_person_deletion_invalid_ids_dropped`, with
   `source` `lookup`, `identified_as` or `job`) has the count, never the id.
   A saved id that a waiting pass can no longer carry is dropped and counted
   (`source: 'job'`, that job's id) when this discovery writes into it.

   The ids found, plus any the job already carried, are then written, in one
   transaction, into `anonymousIds` on every erasure of this account still
   waiting (so the late pass has them after their `$identify` events are
   gone), and into a new `stage: 'delete'` job for this pass. **If the lookup
   fails in any way, a rejected query included, nothing is deleted and the job
   retries**: deleting first would erase the history a fixed query needs.
2. **Delete** (`stage: 'delete'`). `POST /api/projects/<id>/persons/bulk_delete/`
   (`person:write`): `distinct_ids` is the account id plus the persisted
   anonymous ids, `delete_events: true`, `delete_recordings: true`. It never
   looks up again; its retries reuse the same ids. What happens next is
   PostHog's:
   - The person records and their distinct ids are removed in the background
     shortly after the request (`persons_queued_for_deletion` in the response),
     or during it if PostHog runs in synchronous mode (`persons_deleted`).
   - Events and recordings are deleted by a later PostHog batch, which can take
     days. `GET /api/projects/<id>/persons/deletion_status/` lists what is
     still pending.

Responses:

- **Done** only on a 2xx from the delete whose body is the documented
  `PersonBulkDeleteResponse` (`persons_found` and `persons_queued_for_deletion`
  as counts, `persons_deleted` a count when present, `deletion_errors` a list
  when present), with no `deletion_errors` and every matched person accounted
  for: `persons_deleted + persons_queued_for_deletion >= persons_found`, an
  absent `persons_deleted` read as 0. PostHog answers in one of two modes
  (`PERSON_BULK_DELETE_ASYNC`). Queued, which PostHog Cloud documents, reports
  every match in `persons_queued_for_deletion` with `persons_deleted` 0;
  synchronous reports what went in `persons_deleted` with nothing queued. Both
  count as done. No matching person is a 202 with every count zero, still done.
- **Retry** on a 2xx without that body (no body, not JSON, truncated, a proxy's
  page: none of them prove a deletion), on a non-empty `deletion_errors`, when
  fewer persons were deleted or queued than matched, and,
  on either call, on 401, 403, 404, 408, 429, 5xx, a timeout or a network
  error. A 404 is not "nothing to delete": PostHog never answers that way, so
  it means `POSTHOG_PROJECT_ID` or `POSTHOG_API_HOST` is wrong. 401, 403 and
  404 log at error with the URL (host and path; the key travels in a header and
  is never logged).
- **Failed at once**, without spending retries, on any other 4xx from the
  delete: our request is wrong. Logged as an error. Any other 4xx from the
  lookup retries instead (above), so a broken query blocks erasures, visibly,
  until it is fixed and the failed jobs are replayed, rather than deleting the
  history it needs.
- **A job it cannot read.** A bad entry in `anonymousIds` (not a string, empty,
  over 200 characters, carrying a control character or half of a surrogate
  pair, or the field not a list) is dropped at either step and
  counted in `posthog_person_deletion_invalid_ids_dropped`; the account id is
  still erased. A bad `distinctId`, `reason`, `pass` or `stage` fails the job
  at once with `posthog_person_deletion_invalid_job`, which logs the `jobId`,
  the `distinctId` (cut to 200 characters) and the names of the bad fields, so
  it can be replayed by hand (below).

Retries back off from 60 to 120 seconds up to a 6-hour cap, 12 of them,
26.5 to 32.5 hours in all; a job that runs out is `failed` and logs
`posthog_person_deletion_exhausted`. A retried job's output is the error,
cut to 1,000 characters, control characters and half surrogate pairs replaced
with spaces (pg-boss cannot store a NUL or half a pair, and would record its
own jsonb error in place of the real one). A failed query is stored as
`DrizzleQueryError: <database error> (<code>)`, for example
`invalid byte sequence for encoding "UTF8": 0x00 (22021)`, never the SQL or its
parameters: drizzle puts every parameter in the message, and they can be other
accounts' ids, which `pgboss.job` would keep for 7 days. A queued job waits up
to 14 days past its start for a worker (`retentionSeconds`). A finished or
failed job is kept 7 days so a failed erasure can be replayed, then pg-boss
deletes it.

### Configuration

**`POSTHOG_ERASURE_API_KEY` must be set on the Railway backend service before
this deploys.** It is a dedicated PostHog personal API key, scoped to project
412845 with `person:write` and `query:read` and nothing else. It is not
`POSTHOG_PERSONAL_API_KEY`: that one is read-only and shared with
refresh-recommendations and CI's OTA health check. Optional:
`POSTHOG_PROJECT_ID`, default `412845`; `POSTHOG_API_HOST`, default
`https://us.posthog.com` (the private API host, not the `us.i.posthog.com`
ingestion host).

Only a production backend that holds the key registers the worker. Anywhere
else (the key unset, a dev or preview backend, a debug run pointed at the
production database) no worker runs, boot logs
`posthog_person_deletion_unconfigured` (at error level in production), and the
jobs wait in `created` without spending a retry. Setting the key and
redeploying within 14 days erases every one of them. A worker without the key
would burn the 12 retries in about 30 hours and lose the job.

### When a job is missed

The backend starts the queue before it starts listening, and on shutdown it
stops the queue's workers first but keeps taking jobs until the WebSocket and
HTTP servers have closed, so a mutation still running during a deploy can
enqueue. If an enqueue fails anyway, the deletion or withdrawal still commits
and the backend logs `posthog_person_deletion_not_queued` at error level with
the `distinctId`. Once `deleteAccount` commits, that log line is the only
record of whose person to erase. Replay it from a backend shell (both passes):

```ts
await boss.send('posthog-person-deletion', { distinctId, reason: 'account_deleted', pass: 'first' }, { startAfter: 900 });
await boss.send('posthog-person-deletion', { distinctId, reason: 'account_deleted', pass: 'late' }, { startAfter: 604800 });
```

Use `reason: 'consent_withdrawn'` for a withdrawal. A `failed` job (`SELECT
id, data FROM pgboss.job WHERE name = 'posthog-person-deletion' AND state =
'failed'`, kept 7 days) is replayed with `boss.retry('posthog-person-deletion',
id)`. A failed discovery job deleted nothing, so its replay still finds the
split persons; a failed `delete` job carries its ids.

### Not covered

- **A device that said Allow and was never signed in.** Its person is keyed by
  an SDK-generated id the server never sees, and withdrawal on that device
  resets the SDK, so nothing new joins it.
- **Party-UUID persons that never met a sign-in on that install.** Before
  #6078 a signed-out install identified as its party UUID on every launch, and
  each launch's anonymous id joined that person. The lookup above reaches it
  only through an anonymous id the account later signed in from. A party person
  whose install never signed in, or signed in only after a reset gave it a
  fresh anonymous id, stays, with any install-referrer or Apple Ads properties
  set on it while signed out. Nothing in PostHog links it to the account; it
  would take a one-off cleanup by party UUID.
- **An anonymous id shared with another account** is skipped (above), so that
  pre-sign-in person stays.
- **A re-grant.** A climber who withdraws and later says Allow again is
  identified with the same account id, and PostHog advises against reusing a
  deleted distinct id: the new person can stay hidden from insights, cohorts
  and person-targeted flags. PostHog's fix is `POST
  /api/projects/<id>/persons/reset_person_distinct_id/` with `{"distinct_id":
  "<account id>"}`, or "Reset deleted person" on the persons page. It does
  nothing until a live person uses the id, so it has to run after the client's
  first identify following the grant, which the backend does not see, and a
  `late` pass that runs after the re-grant hides the id again. So it is not
  automated: reset an account by hand when it matters. A re-grant within 7 days
  also loses what was captured between the grant and the `late` pass; erring
  toward deletion is deliberate.

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
  66 × DAU rows at the 60-day cap. It is not a write-hot table in the
  [postgres-query-costs](./postgres-query-costs.md) sense.
- **What counts as active.** Signed-in climbers only, and any authenticated
  request counts: a background refetch or a WebSocket reconnect the app makes on
  its own counts the day as much as a tap does. Signed-out visitors are not in
  it at all.
- **Platform.** HTTP clients send `x-boardsesh-platform: web|ios|android`;
  graphql-ws clients send `clientPlatform` in `connection_init` (browsers can't
  set headers on a WebSocket upgrade). Anything else is counted as `unknown`.
  The constants are `CLIENT_PLATFORM_HEADER` and
  `CLIENT_PLATFORM_CONNECTION_PARAM` in `@boardsesh/shared-schema`. Backend CORS
  allows the header. The app sends both. www sends the header on HTTP and
  `clientPlatform: 'web'` on its WebSocket. Until October 2026 the www socket
  sent nothing, so a www climber with a socket open landed in both `web` and
  `unknown` on the same day; read `unknown` before then as mostly www.
- **Snapshot.** The scheduler's `snapshot-active-users` job (00:20 UTC) calls
  the cron-only `snapshotActiveUsers` mutation. It counts yesterday's DAU and
  the trailing 7-day WAU and 30-day MAU, overall and per platform, and sends
  PostHog one `Active Users Snapshot` event on `system:active-users`, dated to
  the counted day, with a uuid derived from the day so a re-run collapses into
  the first copy. Properties: `day`, `dailyActiveUsers`, `weeklyActiveUsers`,
  `monthlyActiveUsers`, and the same per platform (`dailyActiveUsersIos`,
  `monthlyActiveUsersWeb`, ...). Counts only.
- **Retention.** The scheduler's `purge-user-activity` job (07:30 UTC) calls
  `purgeExpiredUserActivity`, which deletes rows older than 60 days
  (`USER_ACTIVITY_RETENTION_DAYS`). The longest window anything reads is the
  trailing 30-day MAU; the other 30 days let a failed snapshot be re-run up to
  a month late with `snapshotActiveUsers(day: "YYYY-MM-DD")` (any day from
  yesterday back to 30 days ago, below). Nothing computes yearly actives; one
  that wants them needs a longer retention argued here first.
- **Known gap.** A signed-out climber who declines can't be deduplicated
  without storing an identifier, so they are not in MAU.

Manual runs: `scheduler run snapshot-active-users`, or POST to the backend
`/graphql` with `Authorization: Bearer $CRON_SECRET`:

```json
{"query":"mutation { snapshotActiveUsers { day dailyActiveUsers weeklyActiveUsers monthlyActiveUsers captured } }"}
```

To re-run a day the job missed, pass it: `snapshotActiveUsers(day: "2026-10-05")`.
The event is dated and keyed to that day, so it lands where the missing point
was, and a day that did send collapses into its first copy. A day before 30
days ago, today or a malformed date is refused (`BAD_USER_INPUT`).


## Account synchronization

`createConsentSyncCoordinator` in `@boardsesh/consent` owns the merge and retry
rules for both clients. The platform injects transport and storage. Every server
response belongs to an account epoch; a response from a previous sign-in cannot
change the active account or device. A new decision changes the device choice
immediately, then is persisted as a pending write under that account before the
network request. Offline withdrawals survive restart. Pending decisions are
pushed before old account answers are merged, so changing No thanks to Allow
is not immediately undone by the old account denial.

Only two things are ever written to an account:

1. A decision the climber makes on this device while signed in to it (`decide`),
   including its durable retries.
2. A decision this device made under the same account whose write was lost,
   and only while the account still holds exactly the answer that decision was
   made against (`basedOnDecidedAt`). It is written with that answer as its
   compare-and-set token. No clocks are compared, so a phone whose clock runs
   ahead cannot re-deny a newer answer, and a copy adopted from the account is
   never written back. The recovered write stays conditional all the way to
   the database: its pending record carries `conditional: true` and the token,
   and the server checks the token under the per-user lock for a denial too. A
   retry or a restart sends it again without reading the account, so this is
   what stops it overwriting an Allow another device wrote in between. When the
   server refuses it, the device merges the answer it gets back like a fresh
   read: a newer Allow leaves this device on its own No thanks (rule 3), a newer
   denial is adopted (rule 2).

An explicit No thanks and its durable retries are never conditional: they send
`basedOnDecidedAt: null`, so the climber's own withdrawal always lands. An
explicit Allow keeps its token, which the server checks for every grant.

A stored answer is never pushed over a newer account answer. Say No thanks on
phone A, later Allow on phone B: when A comes back, the account stays Allow and
no event is appended; A keeps its own No thanks (rule 3). A shared-cookie
withdrawal that arrives while a grant is in flight stops tracking on this
device and drops the grant, but is not written by this tab: the origin that
took it writes it if it was signed in.
If the app is killed before that dropped grant leaves pending storage, the
restored grant meets the newer denial on the next launch, loses, and is
discarded. The denial is not written before the account is read: after the
read, rule 2 decides, so an adopted or stale denial never flips a newer grant
made on another device.

The app's consent gate waits for the account read (at most 5 s, as for a
first answer) before it trusts an answer that is not this account's. While the
profile id is still loading it waits on an answer with no owner, and settles
at once on one bound to an account. When the account has none, the prompt
opens; when the read never returns, the gate settles on the device answer and
tracking stays off until the account resolves. On the browser app the cookie
never names an account, so every signed-in page load waits for that one read
before deep links, share targets and the onboarding steps proceed. That is the
cost of the cookie carrying no account, not a bug.
The website clears the cookie, which shows the banner again.

The coordinator retains the precise last-server `decidedAt` for compare-and-set.
The browser cookie rounds to whole seconds and is never used as a server token.
A pending grant keeps the token from when it was decided; a retry does not fetch
a newer denial and pretend that the old grant was based on it. Reads append
nothing when device and account already agree. Pending records are validated
before storage can restore an analytics grant.

## Website and browser app

The website renders the same analytics components for every request; the banner
itself appears only after the browser's region lookup (see
[Who is asked](#who-is-asked)). A pre-paint script reads the current, valid
`boardsesh-consent` cookie, region default included, and sets
`html[data-consent]`; CSS hides answered banners before hydration. Request
cookies and the visitor's country never determine cached HTML. The one-year cookie uses Path=/,
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
Signed out, every flag request buckets on the browser's flags-only id from
IndexedDB, with or without consent, so Allow does not move a visitor to another
rollout bucket ([feature-flags.md](./feature-flags.md#anonymous-bucketing)).
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
On anonymous-to-signed-in transitions, a temporary authority check preserves
the already-consented acquisition identity and queued conversions while
blocking transport. Functional flags use a separate memory client during the
hold. A denial, sign-out or change away from an authenticated account discards
that identity and queue. The landing campaign is snapshotted in document memory
before navigation, so a later Allow retains the original tags without emitting
pre-consent events or persisting the campaign.
An external cookie grant blocks capture before notifying SDK subscribers and
requires a fresh consent read for the current authenticated account; the cookie
cannot authorize a different account. Signed-out visitors can accept a shared
grant immediately. Account responses also re-read the cookie before merging so
a delayed grant cannot overwrite a newer withdrawal.
Pageviews, vitals collection and vitals flushing check consent explicitly.
Withdrawing discards the buffered metrics. Reset on sign-out reapplies the
existing device opt state and web super properties. HTTP GraphQL requests send
x-boardsesh-platform: web so signed-in first-party activity remains counted.

The backend PostHog proxy never forwards the HTTP User-Agent. It forwards the
visitor IP as `X-Forwarded-For` only when all of these hold:

- the path is a capture path (`/batch`, `/e`, `/i/v0/e`, `/s`);
- the request carries `x-boardsesh-analytics-consent: granted`
  (`ANALYTICS_CONSENT_HEADER` in `@boardsesh/consent`), which a client adds
  while analytics is on: an Allow, or a region default this launch confirmed;
- it came through a trusted Cloudflare edge, and the address is the public
  `CF-Connecting-IP` that edge reports (`resolveEdgeVisitorIp` in
  `packages/backend/src/utils/flag-country.ts`, the same trust boundary as the
  flag country in [Cloudflare](./cloudflare.md)).

Earlier `X-Forwarded-For` entries are caller-controlled and are never used, nor
is the socket peer (our own ingress), a private or carrier-grade NAT address,
or a request that did not come through Cloudflare. Web and app add the header
only to capture sent while analytics is on, an Allow or a region default
confirmed this launch (not to flags or the SDK config request); www adds it only when it talks to exactly our proxy, not to a
direct-to-PostHog override. Everything else is stripped: flags, the public
config request, surveys, logs, the anonymous OTA health event, kiosk telemetry
and any older client. The default is strip, so a missing or
mistyped header can only lose a consented event's location, never locate an
anonymous one. Without the forwarded IP, PostHog geolocated consented events
and overwrote person `$geoip_*` properties with the backend's own location.
Granted analytics explicitly supplies its consented user-agent event property;
operational events use minimal payloads.
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

Mobile signup/login conversions taken with an existing Allow can wait up to
two minutes for account consent and SDK identity to resolve. This bounded,
memory-only work belongs to the authentication epoch and keeps the conversion's
original timestamp. A withdrawal, kill switch or account replacement discards
it; later Allow never replays a conversion taken without consent.

Consent copy and equal-choice controls follow the [EDPB consent guidelines](https://www.edpb.europa.eu/sites/default/files/files/file1/edpb_guidelines_202005_consent_en.pdf). Declining does not limit the app, and withdrawal uses the same two-choice controls.
