# Offline mode fleet health and default decision

**Decision on 21 November 2026: keep “Keep boards offline” opt-in.** The current fleet does not yet support a high-success conclusion for automatic catalogue downloads. Recent 2.7.0 downloads are substantially healthier, but the mature 2.7.0 sample contains no starts attributable to the global setting. The product decision was delegated to an independent GPT-6.2 Astra subagent, as requested, after agreeing evidence criteria before examining results.

This is the current health review for [epic #4319](https://github.com/boardsesh/boardsesh/issues/4319). No runtime defaults, remote flags, existing preferences or production data change with this report.

## What would change

Three controls have different meanings:

| Control | Current behavior | Decision |
| --- | --- | --- |
| Native offline engine | Baked on; mirrors user data and drains queued writes independently of board downloads | Keep running |
| `autoOfflineBoards`, “Keep boards offline” | Defaults false; downloads My Boards through the Settings effect and automatically downloads subsequently adopted boards | Hold default change |
| `offlineMode`, “Offline mode” | Defaults false; deliberately suppresses network requests while enabled | Keep deliberate |

The epic's [#4312 engine availability fix](https://github.com/boardsesh/boardsesh/issues/4312) is already shipped. Making automatic downloads the default is a separate expansion of storage, transfer and import work. A future default change should affect unset preferences; persisted explicit false must remain false. The Settings effect's mount location also matters: changing one default alone does not eagerly download every existing board at app launch.

Source: [settings defaults](../../packages/mobile/src/settings/defaults.ts), [settings reads](../../packages/mobile/src/settings/hooks.ts), [automatic downloads](../../packages/mobile/src/offline/use-keep-boards-offline.ts), [toggle handler](../../packages/mobile/src/components/settings/offline/auto-offline-boards-toggle.ts), and [adoption policy](../../packages/mobile/src/lib/board-discovery/adopt-found-board-decision.ts).

## Evidence scope and definitions

PostHog production project 412845 was queried on 21 November 2026. The project metric catalog contains no approved offline-health definition; these are noncanonical exploratory measures.

| Question | UTC window, lower bound inclusive and upper bound exclusive |
| --- | --- |
| Recent health, writes, reads and latency | 24 October to 21 November |
| Mature download starts | 17 October to 14 November, followed through 21 November |
| Recent download sensitivity | 14 November to 20 November, with 24 hours allowed |
| Latest fleet composition | 14 November to 21 November |

All reported health queries require production environment, iOS, iPadOS or Android, and the captured native app namespace `com.boardsesh.app`; they exclude project-defined internal/test accounts and an explicitly non-production OTA branch. Missing branch tags remain eligible. Browser events represented 452 people and contributed zero offline reads or download starts. Excluding browser events reduced the distinct-person denominator from 3,995 to 3,555 because some people used both clients. Queries use fixed UTC boundaries to avoid partial current-day data; these are measurement boundaries, independent of the reader's timezone.

A download match means a Started event is followed by Completed on the same `distinct_id + OS + scopeKey`, before another Started, within the follow-up window. Streams are ordered by timestamp and event UUID. Failed events do not close this eventual-completion measure: a recoverable failure can precede completion. A new start before completion is counted unmatched and separately described as a restart. There is no captured `$device_id`; distinct ID plus OS is a client proxy, not a verified hardware identity. People are counted with `person_id`.

Unmatched starts are **not** proof of terminal download failure. They can reflect abandonment, pauses, event delivery loss, changed client identity, or the chosen deadline. Completion-only latency excludes unmatched work. People with at least one completion can still have another board incomplete, so the stricter “every observed start completed” count is reported too.

PostHog coverage follows [analytics consent](../analytics/analytics-consent.md). Unreported or never-reconnected clients are absent; these counts are observed people, not a census of the fleet. Native app version does not identify the running JS bundle: OTA IDs and embedded status must accompany any attribution of a fix. No causal experiment establishes that enabling the default improves retention.

Exact SQL, filters and aggregate returned rows are retained in [download cohort evidence](evidence/offline-download-cohorts-2026-11-21.json) and [health evidence](evidence/offline-health-2026-11-21.json). To rerun via execute-sql, supply the saved top-level filters object alongside the query; it fills each `{filters}` placeholder, including internal/test exclusion. Queries can also be opened in the [PostHog SQL editor](https://us.posthog.com/project/412845/sql) with the same filters.

## Downloads have improved but the fleet is mixed

### Mature completion within seven days

| Cohort at start | Matched completions / starts | Observed match share |
| --- | --- | --- |
| All native clients | 697 / 937 | 74.4% |
| Android | 189 / 273 | 69.2% |
| iOS | 506 / 662 | 76.4% |
| iPadOS | 2 / 2 | Too small to generalize |
| Native version 2.6.0 | 497 / 719 | 69.1% |
| Native version 2.7.0 | 171 / 175 | 97.7% |
| Kilter | 282 / 411 | 68.6% |
| MoonBoard | 181 / 271 | 66.8% |
| Tension | 140 / 159 | 88.1% |

Across 713 observed people who started, 518 had at least one matched completion and 490 completed every observed start. That does not establish completion of every requested board: schema, readiness or connectivity can prevent an enabled scope from ever emitting Started. Request completeness needs a matched enable/request denominator as well. Eleven starts were followed by another start before completion. The remaining unmatched population needs classification; calling it a 25.6% definitive failure rate would overstate the evidence.

Version 2.7.0 is the promising result: 20/20 Android, 150/154 iOS and 1/1 iPadOS starts matched. However, none of those 175 mature starts carried `download-all`, `auto-download-all` or `adopt-auto` trigger tags. It therefore does not establish the reliability of the specific setting being proposed as the default.

### Automatic and bulk download evidence

| Trigger population, all versions | Completions / starts | People completing every observed start |
| --- | --- | --- |
| `auto-download-all` plus `adopt-auto` | 18 / 19 | 13 / 14 |
| Above plus deliberate `download-all` | 21 / 30 | 14 / 16 |

The automatic result is encouraging but narrow: ten of its nineteen starts were spray walls and only two were Kilter. All three Kilter scopes from deliberate `download-all` lacked a seven-day match. Three scopes are an investigation lead, not a general estimate of bulk Kilter reliability. An owned-wall automatic pin is excluded from these setting-attributed groups because ownership can pin it independently of the global preference.

In the recent 24-hour sensitivity window, 2.7.0 matched 114/121 starts. Its nine switch-related starts all completed, across eight people, all on iOS. Version 2.7.1 matched 4/4, including one setting-related start per platform; 2.8.0 matched one Android start outside the setting cohort. Android 2.6.0 matched 30/51. The newer samples should mature before a default decision, especially the Android bulk path.

### Speed and the slow tail

Across mature matched starts, elapsed start-to-completion p50 is 74 seconds and p90 is 76,426 seconds, about 21 hours. Kilter p50 is 237 seconds. These are calendar elapsed times including pauses and later cycles, not download transfer speed.

The more comparable recent snapshot-completion slice uses `method = snapshot`, false or missing `bootstrapHealed`, and a recorded `durationMs`. It measures the completion event's scope-lifetime duration:

| Native version and platform, Kilter | Completions | p50 | p90 |
| --- | --- | --- | --- |
| 2.6.0 Android | 59 | 77 seconds | 2,901 seconds |
| 2.6.0 iOS | 108 | 134 seconds | 3,404 seconds |
| 2.7.0 Android | 9 | 36 seconds | 94 seconds |
| 2.7.0 iOS | 87 | 60 seconds | 1,229 seconds |

The latest medians improve, but the iOS tail remains material. Completion-only timings do not cover abandoned imports, and changed duration semantics prevent directly equating these numbers with the epic's August baseline.

There were 172 Download Failed events in the recent-health window. Of these, 101 were expected background pauses and three deliberate disabled-download abandonments. The remaining signatures included 24 watermark regressions, 23 unknown failures, twelve database locks, five background-transfer decode failures and four network failures. Events are not independent download attempts and must not be divided into completion counts to manufacture a success rate.

## Offline reads deliver value

The 28-day observed native population is 3,555 people. Instrumented local reads reached 1,061 people; 340 had at least one read in a genuinely offline or network-fallback lane, 9.6% of the observed population. This includes user-data surfaces such as logbook, favorites and playlists; it is not wholly attributable to downloaded board catalogues.

| Read lane | Observed people | Rolled-up events |
| --- | --- | --- |
| `online_local` | 911 | 6,627 |
| `network_error_local` | 325 | 605 |
| `offline_local` | 22 | 39 |

People overlap between lanes. The four non-online lanes belong in the offline-value definition, including `offline_mode_local` and `backend_unreachable_local`; those latter two produced no observed events in this window. The 340-person union cannot be obtained by summing lane counts.

Read events fire at daily per-board/lane count rungs 1, 10 and 100. Neither their event totals nor the sum of `readCount` is a total-read denominator. This prevents calculating a truthful read success percentage from Served and Unavailable.

Unavailable reads affected 23 people across 29 rolled-up events, all `board_not_downloaded`. This identifies useful demand for pre-downloads. Zero observed `local_db_unavailable` events does not independently establish universal database readiness. These signals cover the instrumented board surfaces, not every cache-backed screen or cold-start flow; [offline reads](offline-reads.md) defines that boundary.

## Writes and synchronization still need attention

| Recent-health signal | Events | Distinct observed people | Interpretation |
| --- | --- | --- | --- |
| Local write retry entered | 72 | 34 | 59 exhausted, thirteen recovered |
| Tick local write failed | 30 | 25 | Seven retained through outbox fallback; 23 fell through to network |
| Mutation dead-lettered | 5 | 3 | Requires reconciliation; not automatically proof of lost server data |
| Launch found an outbox backlog | 32 | 24 | Repeated launch observations, not 32 unique backlogs |
| Whole sync cycle failed | 3,339 | 773 | Mixed expected interruptions and genuine exceptions |

Every observed Tick Local Write Failed event had `wasOffline = false`. This audit therefore finds no directly observed offline tick loss in that event. A network fall-through while online is not proof of either successful server save or loss. The local retry and tick fallback events describe layers of the same failure and must not be added together.

The five dead letters were three tick creates rejected with `CLIMB_NOT_FOUND` on Android 2.6.0, one tick finalize failure on Android 2.3.1, and one favorite finalize lock on Android 2.5.0. A post-send bookkeeping failure can dead-letter an already accepted write, as [#5305](https://github.com/boardsesh/boardsesh/issues/5305) explains. Reconcile the tick IDs against the server before labeling these sends lost.

Backlog observations include iOS 2.7.0: five people, pending ages up to eight days, and up to three dead letters in one observation. Counts are launch snapshots; there is no paired empty-outbox event establishing later recovery. Older Android pending work reached 26 days. In the latest seven days there were six backlog observations across six people, twelve tick-local failures across twelve people and one new dead letter on Android 2.3.1; the exact running OTA is required before attributing the underlying defect.

The 3,339 cycle failures split into 2,087 expected aborts, 829 expected network failures, 366 unexpected exceptions, 43 server-unavailable failures and fourteen server failures. A server-unavailable failure is an availability signal even where the older `expected` property is false; it is not evidence of a SQLite defect. There is no captured successful-cycle denominator, so this count is not a sync failure rate.

Coverage evaluations were mostly healthy: 3,461 fresh observations across 1,695 people. Unknown coverage appeared in 27 observations across 25 people. Four stale/reset observations and three stale/evaluated observations are distinct from the six coverage-reset events; deduplication and reset paths differ, so they should not be forced to agree.

### Current Android risk and release eligibility

Over the latest complete seven days, Android 2.6.0 was observed for 375 people, versus 49 on Android 2.7.0 and 42 on Android 2.7.1. These are per-version people, with possible overlap after upgrades. The older Android population remains significant. Native 2.7.0 iOS reached 907 people; newer version observations are much smaller.

[#6689](https://github.com/boardsesh/boardsesh/issues/6689) tracks Android session-long write locks. The 21 November update on [#6707](https://github.com/boardsesh/boardsesh/issues/6707#issuecomment-7061304014) says current main uses expo-sqlite 58.0.18, where the historical cached-list alias defect is already fixed upstream. Runtime recovery and in-flight-call behavior still need device verification. This evidence does not justify another native patch based on the old SDK57 diagnosis.

Not every failure can be assigned to a runtime reload: recent exhausted 2.6.0 tick writes include fourteen events with `jsRestartCount = 0` and four with `1`. One Android 2.7.1 write and one iOS 2.7.0 write also exhausted retries. Version-only filtering must not turn an inferred mechanism into a universal cause.

A source-default change only reaches clients running a bundle that contains it; it does not remotely switch every old store install. A future proposal may define a narrower eligible runtime/OTA cohort and evaluate that cohort separately. The current evidence does not yet establish representative automatic-download health even for the promising 2.7.0 subset.

## Observability limits

Mutation delivery is published in-process by the mobile adapter, but the audited analytics events do not pair every durably queued offline write with server acceptance and local reconciliation. Tick Logged and the absence of dead letters do not fill that gap. This audit cannot claim an end-to-end offline write success rate.

The connected Grafana instance exposes DR, worker and upstream board-sync dashboards, rather than an instrumented client-offline dashboard. Metric-name discovery found DR/worker metrics but no dedicated client offline counters. That source cannot validate client-side download or reconciliation success. A missing offline alert is not evidence of a healthy fleet. No live Sentry connector was available; GitHub's mirrored historical Sentry incidents are context, not a fresh Sentry census.

## Decisions and conditions for reconsideration

Astra's decision is **HOLD**, not a conclusion that offline mode is unusable. The new release evidence, real fallback reads and low current unavailable-read volume support continuing the shipped opt-in experience.

1. Keep `autoOfflineBoards = false` until the eligible rollout cohort has representative automatic and bulk downloads on iOS and Android, including Kilter and multiple requested scopes per person.
2. Repeat the same ordered match query with seven days of follow-up; report per-scope completion, every-requested-board completion, restarts and classified unmatched starts. Set an explicit acceptable product target before judging that result.
3. Reconcile aged and dead-lettered ticks, and establish offline enqueue-to-server-acceptance-to-local-reconciliation evidence, through correlated telemetry or independent production receipts.
4. Verify Android runtime-reload recovery on the shipped runtime and distinguish existing old-fleet failures from the versions that will receive the new default.
5. If those gates pass, change only the automatic-download default and retain explicit opt-outs. Verify and adjudicate fresh automatic bulk downloads on cellular and their storage cost before expansion; current metered deferral is not a blanket Wi-Fi-only rule. Measure opt-outs, completion and writes during rollout.

No invented fixed sample threshold or broad engine rollback is required. The next decision should name the actual receiving native runtimes and OTA bundles, with both platform and heavy-board coverage, rather than treating all native app versions as one release.

