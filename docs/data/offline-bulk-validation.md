# Automatic offline downloads: release validation (#7989)

## 1. Freeze the candidate before enrollment

**21 November 2026 decision: HOLD.** This change supplies measurement and a repeatable decision tool. It does not enable automatic downloads. Receiving runtime/bundle identities, device measurements, mature candidate outcomes and blocking-issue dispositions have not been collected. The [example input](evidence/offline-bulk-validation-7989.example.json) is synthetic and can never authorize GO.

Freeze a study input before the first enrolled request: `preregisteredAt`, fixed UTC `enrollmentStart` (inclusive) and `enrollmentEnd` (exclusive), and exact eligible release entries. Each entry names `platform` (`ios`, including iPadOS, or `android`), native version/build, runtime fingerprint, and either the OTA update ID or an immutable embedded-bundle identity. A version number alone does not establish eligibility. Store this manifest in a reviewed commit before adding outcomes. Stop enrollment at the declared cutoff; do not repeatedly peek and stop when confidence first passes. Observe through at least seven complete days after enrollment closes. Every declared receiving release needs fresh automatic production requests and fresh automatic device evidence; an untested runtime or bundle cannot inherit another release's GO.

| Gate, automatic cohort separately on each platform | Predeclared target |
| --- | --- |
| All requested scopes completed within seven days of request | ≥99% |
| People completing every requested scope within seven days | ≥95% |
| One-sided 95% exact confidence lower bounds | ≥99% scope sample; ≥95% people |
| Actual cellular traffic for one automatic batch, retries included | ≤500 MiB |
| Total retained / peak device storage for a batch | ≤2 GiB / ≤4 GiB |

These are **noncanonical exploratory release-validation measures**, not approved catalog metrics. Production PostHog project 412845 currently has no approved offline-health definition. The software gates follow the user-approved thresholds; changing them creates a new preregistration, not a retrospective pass.

## 2. Collect requests and device evidence

`Offline Board Download Requested` supplies one `requestId` per unique requested scope and one `batchId` for the new scopes in an enable operation. Persisted correlation survives lack of signal, schema delays, retries and relaunch. Existing start/completion/failure events carry `bulkRequestId` alongside #7992’s operational `requestId` and `attemptId`; these identities describe different measurement lifetimes. Request events use the bulk identity as `requestId`. Correlated cancellation is recorded by Request Resolved. `Offline Board Download Request Started` records each new request when the engine touches its pending scope, even when a durable legacy start marker survives an earlier disable. `Offline Board Download Request Resolved` supplies `completed`, `already_available` or `cancelled`, including outcomes before a Started event. A retry does not reset the request clock. A later removal/re-enable creates a fresh request. Already-available resolutions count as available scopes in the full request denominator and are reported separately. They cannot supply fresh-download confidence or heavy-transfer coverage.

1. Exercise fresh downloads through `auto-download-all` and `adopt-auto` on **both** platforms, with fresh production requests and fresh device evidence for each trigger. Report deliberate `download-all` separately and descriptively; it cannot substitute for automatic production evidence.
2. Include heavy Kilter and multiple unique requested scopes in one batch. Test two board cards sharing a scope. Include foreground, background, relaunch/reconnect and cellular scenarios using fresh downloads. Cached-board cases cannot supply a missing lifecycle scenario.
3. Capture **actual transferred bytes** with device/network traffic recording, including failed attempts and retries through relaunch. Expo's Android gzip progress may count decoded bytes; `wireBytes` is the manifest object size. Neither proves actual traffic. Isolate batch traffic from unrelated app traffic, and retain the capture/counter baseline and attribution method.
4. Measure database, `-wal`, `-shm`, downloaded/retained artifacts and wall photographs together. Record retained bytes after settling and the maximum observed during transfer/import/retry. Record sampling interval and coverage, including suspension and relaunch. Do not mark `peakCoverage: complete` if a background gap could conceal the peak. Incomplete measurement remains HOLD.
5. Attach a release-specific linked disposition for #7985–#7988, #6689/#6707 and #4310/#4394. `cleared` or `not-applicable` needs evidence; unresolved writes, delivery measurement or relevant runtime/performance work blocks GO. Zero observed dead letters is not write-integrity proof.

The `devices` array contains **one consolidated entry per measured batch**, including cumulative retry traffic, complete-storage accounting and evidence paths/links. Record `completedScopeCount` and `offlineAvailableAfterRelaunch`; every requested scope must complete and remain available offline after relaunch. Failed or unknown outcomes remain HOLD. `freshDownload` distinguishes uncached downloads from already-available scopes; each platform needs fresh heavy Kilter bulk coverage and a fresh automatic multi-scope cellular batch with positive measured traffic. Required fields and enums are validated by `parseOfflineBulkValidation` in the [tool](../../scripts/offline-bulk-validation.ts). Do not save captures containing accounts, payloads or tokens in the public repository; save reviewed aggregate receipts and safe evidence links. Keep task scratch output in the task artifact folder rather than shared `/tmp`.

## 3. Reproduce production observations

Run the following event extract against PostHog project **412845**, substituting the fixed preregistered boundaries. The first query deliberately reaches through the observation cutoff, so a request near enrollment end can receive its full seven days. Export exact query text, the filters object and returned aggregate rows as evidence. Queries and properties must be verified on the instrumented candidate before enrollment. Request-event arrival is not evidence for every unconsented or permanently silent client.

Use this exact filter object with the `{filters}` query placeholder, matching the [21 November health audit](evidence/offline-download-cohorts-2026-11-21.json). Confirm the project's internal/test account definition was applied; `sourceFiltersVerified` must remain false otherwise. Missing OTA branch remains eligible at extraction, but a missing exact receiving bundle is excluded from the candidate and blocks its decision.

```json
{
  "filterTestAccounts": true,
  "properties": [
    { "type": "event", "key": "environment", "operator": "exact", "value": "production" },
    { "type": "event", "key": "$os", "operator": "exact", "value": ["iOS", "iPadOS", "Android"] },
    { "type": "hogql", "key": "coalesce(properties.ota_branch, 'production') = 'production'" },
    { "type": "event", "key": "$app_namespace", "operator": "exact", "value": "com.boardsesh.app" }
  ]
}
```

```sql
SELECT
  uuid,
  timestamp,
  event,
  person_id,
  coalesce(properties.bulkRequestId, properties.requestId) AS request_id,
  properties.requestId AS operational_request_id,
  properties.attemptId AS attempt_id,
  properties.state AS lifecycle_state,
  properties.batchId AS batch_id,
  properties.scopeKey AS scope_key,
  properties.trigger AS trigger,
  properties.requestedAt AS requested_at,
  properties.requestedScopeCount AS requested_scope_count,
  properties.outcome AS outcome,
  properties.resolvedAt AS resolved_at,
  properties.expected AS expected,
  properties.reason AS reason,
  properties.$os AS platform,
  properties.$app_version AS native_version,
  properties.$app_build AS native_build,
  properties.ota_runtime_version AS runtime_version,
  properties.ota_update_id AS update_id,
  properties.ota_is_embedded AS is_embedded,
  properties.ota_branch AS ota_branch
FROM events
WHERE timestamp >= toDateTime('ENROLLMENT_START_UTC')
  AND timestamp <= toDateTime('OBSERVATION_CUTOFF_UTC')
  AND event IN (
    'Offline Board Download Requested',
    'Offline Board Download Started',
    'Offline Board Download Request Started',
    'Offline Board Download Lifecycle',
    'Offline Board Download Completed',
    'Offline Board Download Failed',
    'Offline Board Download Cancelled',
    'Offline Board Download Request Resolved'
  )
  AND coalesce(properties.bulkRequestId, properties.requestId) IS NOT NULL
  AND {filters}
ORDER BY timestamp, uuid
```

Normalize the returned stream **inside the controlled analysis environment** into one request row per `requestId`. Deduplicate event UUIDs first. Use Requested as the denominator and retain its receiving `releaseId`; do not reattribute the request after an upgrade. Also map the exact executing release metadata on Started and completion/resolution to `startedReleaseId` and `completedReleaseId`. These lifecycle releases must be explicitly eligible and on the request's platform. Missing or ineligible lifecycle identity remains HOLD and cannot count as a successful fresh download. Match the earliest correlated `Offline Board Download Started` or `Offline Board Download Request Started` as Started, then the first accepted completed/already-available resolution, cancellation, and classified failure; retain retries/restarts without generating requests. Conflicting Requested identities or contradictory terminal observations must remain review blockers, not favorable arbitrary selections. Event gaps keep unresolved requests in the denominator. Never infer completion from the absence of failure.

For observed restarts, first map operational request IDs to bulk IDs using funnel rows carrying both `requestId` and `bulkRequestId`. Join `Offline Board Download Lifecycle` rows through that mapping, then count distinct `attemptId` values in `started` or `resumed` states after the first attempt. Repeated delivery of one attempt is not another restart. Retain the exact mapping/query receipt; unmapped or undelivered lifecycle observations cannot establish zero restarts and require independent device receipts before the evidence is complete.

Replace person IDs with random study-scoped `personKey` pseudonyms before saving normalized inputs. Use a stable pseudonym for one person across all devices/releases in this study. Replace private spray-wall scope identifiers with study-scoped scope pseudonyms, preserving equal-scope matching, and supply only bounded `boardType` separately. Do not save raw person/account IDs, tick payloads or mutation IDs in aggregate artifacts. The report contains aggregate cohorts rather than request/person rows.

Normalized `requests` require `requestId`, `batchId`, `personKey`, receiving `releaseId`, the original positive `requestedScopeCount`, scope identity, board type, trigger, `requestedAt`, and `restartCount`. Every surviving request in a batch must preserve its declared scope count. The unique observed batch members must match it; missing members stay in the requested denominator and cause HOLD. Never replace the expected count with the number of delivered events.

Optional `startedAt`, `completedAt`, `cancelledAt` and `failure` (`expected`, `genuine`, `unknown`) describe observed outcomes. A `startedAt` requires `startedReleaseId`, and `completedAt` requires `completedReleaseId`. Preserve terminal `outcome` as `completed`, `already_available` or `cancelled`; a timestamp alone cannot establish completion provenance. Identical duplicate rows are removed; contradictory duplicate rows cause HOLD. Set `completedAt` from explicit already-available proof even when no Started exists, and keep its outcome `already_available`. A fresh `completed` outcome needs a correlated Started and eligible executing release proof; lost starts cannot silently become successful funnel evidence. A terminal observed beyond seven days is reported late, not a seven-day success. Preserve missing outcomes as missing; do not fill them with the cutoff timestamp. Save unresolved or inconsistent event classifications for #7987 review.

## 4. Generate and review the report

```sh
vp exec tsx scripts/offline-bulk-validation.ts INPUT.json OUTPUT.json
```

Output is created exclusively: an existing report is never overwritten. Valid incomplete evidence returns a dated HOLD report; malformed inputs exit with an error. Reports include eligibility, fixed boundaries, requested/started/completed counts, all-requested-scope person completion, restarts, cancellations, genuine failures, pending/unknown outcomes and late completions. The synthetic example is runnable and remains HOLD.

Scopes within one person are correlated. Fresh-download confidence excludes only explicit `already_available` outcomes; pending, cancelled and unknown fresh requests stay in its denominator. Select **one** fresh requested scope per person by the lowest SHA-256 hash of the immutable random request ID. Among those fresh requests, selection is independent of success, stable under input ordering and fixed before judging results. The fresh-person endpoint asks whether every fresh request completed within seven days, and incomplete batch delivery prevents person success. Both confidence endpoints use one-sided 95% Clopper–Pearson lower bounds, separately on iOS and Android. The full requested-scope availability rate must also meet 99%, and at least 95% of all observed people must complete every requested scope, including cached availability. With zero failures, 299 independent people/scope samples are needed for the 99% bound and 59 for the 95% person bound. These are consequences of the confidence rule, not a substitute for representative platform/board coverage.

All eligible requested scopes remain in the full denominator, including cancelled, never-started and unknown requests. Report deliberate `download-all` outcomes separately without applying an additional production confidence gate. Consent/event loss restricts interpretation to the observed cohort; device cases or missing clients cannot be assumed successes. The gate also requires fresh production requests and fresh device cases from both automatic triggers, a fresh multi-scope Kilter batch, and every lifecycle scenario on each platform. Strong confidence from one trigger cannot replace missing fresh evidence for the other.

## 5. Record the dated decision

Publish the report with the preregistered manifest, exact query/filter receipts, safe device evidence and linked dependency dispositions. Initial HOLD reasons are missing eligible native/runtime/bundle identities, missing actual byte/storage/device observations, insufficient mature automatic outcomes/confidence, and unresolved dependency dispositions. Do not close #7989 merely because the measurement code merged.

A GO permits a separate default-only PR preserving explicit false preferences and existing Settings activation semantics. `offlineMode` stays deliberate and the native offline engine stays baked on. That future rollout must monitor explicit opt-outs, requested-to-completed downloads, costs and queued-write acceptance/reconciliation against the same receiving release identities; absent evidence or a breached gate returns the decision to HOLD.
