# Offline download outcomes and receiving-release limits

**21 November 2026: fix the demonstrated transfer-classification paths and keep unknown historical outcomes unknown.** This is the request-completeness investigation for [#7987](https://github.com/boardsesh/boardsesh/issues/7987). It does not change the opt-in default decision owned by [#7989](https://github.com/boardsesh/boardsesh/issues/7989).

## Fixed window and reproducible method

The cohort contains anchors in UTC **[17 October, 14 November)**, with observations through **[17 October, 21 November)**. Each request and each start independently gets seven days of follow-up, including an event at exactly seven days. Every cohort anchor has mature follow-up. The export contains 3,760 events: 1,218 toggles, 1,155 starts, 1,139 completions and 248 attempt failures, including follow-up events outside the anchor window.

The original [health report](offline-mode-health-2026-11-21.md) filters are unchanged: PostHog project 412845; production; native namespace `com.boardsesh.app`; iOS/iPadOS/Android; project-defined internal/test accounts excluded; explicitly non-production OTA branches excluded. Missing branch tags remain eligible. This is a noncanonical forensic audit, not an approved metric or a population census.

[Exact SQL, filters, page counts and aggregate results](evidence/offline-download-outcomes-2026-11-21.json) are committed. Raw person/client/event records are not. The export reads only the named tuple fields, orders by timestamp and UUID, and uses timestamp-plus-UUID keyset pagination in eight pages: seven of 500 and one of 260. Do not use SQL `OFFSET`, omit the last page, or sum per-page unique-person counts.

To reproduce, run the saved export query in [PostHog SQL](https://us.posthog.com/project/412845/sql) with its saved structured filters, using the saved keyset predicate after each full page. Parse each `record` cell as a JSON tuple and concatenate the tuples into one JSON array in a task-local ignored file. From the repository root, run `vp exec tsx scripts/offline-download-audit.ts <export.json>`. The script emits aggregate JSON without client or person identifiers. Its deterministic tests cover seven-day boundaries, restarts, duplicate enables, identity changes and generation fences.

Historical request generations are **inferred** from the first observed enabled toggle on `distinct_id + OS + scopeKey`; repeated enables remain in that generation until a disabled toggle or explicit `abandoned-*` diagnostic. The history starts on 17 October, so the first toggle need not be the first ever enable. Each abandonment reason closes the generation even when its disabled toggle was not captured. A modern identified generation requires its matching request ID for terminal attribution: delayed unkeyed legacy terminals cannot settle its replacement. The strict start cohort independently stops attribution at the next start or explicit abandonment. Native version, runtime, OTA and embedded status belong to the anchor; a resumed download can subsequently run another OTA.

`distinct_id + OS` is an observed-client proxy, not a verified hardware ID. Account resets, reinstalls, shared accounts, consent and event delivery can break continuity. The new durable request ID improves scope-generation matching; it does not establish hardware identity or remove missing-event uncertainty.

## Requested boards and started downloads are different denominators

| Seven-day outcome | Inferred enable generations | Strict start cohort |
| --- | ---: | ---: |
| Completed | 669 | 697 |
| No observed start or completion | 37 | Not applicable |
| Explicit abandonment | 20 | 7 |
| Confirmed terminal request failure | Not observable historically | Not observable historically |
| Unknown after a start | 210 | 233 |
| Total | 936 | 937 |

The request cohort contains 709 observed people; **473 completed every observed requested generation**. The start cohort contains 713 observed people; 490 completed every observed start. These are separate populations: a start can lack a captured enable, while an enable can lack a captured start. The latter cannot be repaired by substituting the started-only denominator.

The classifier returns zero `confirmed-failure` observations because none of these legacy event types proves a whole request ended without recovery or paging remaining. This is an observability limitation, not a finding that no request failed. Legacy `Offline Board Download Failed` events describe bootstrap attempts. Even a watermark regression, database lock or `unknown` exception cannot alone establish terminal request failure.

The 37 no-start observations cannot be assigned to schema readiness, connectivity, already-cached boards or missing delivery from old events. No historical cached completion is counted without proof. New lifecycle reporting identifies deferred requests and completion from existing committed markers, so an already-downloaded board is not falsely called a stalled new transfer.

There are **three restarts within seven days** in each cohort. The prior report's eleven next-start observations used the whole observation period; eight happen after the earlier start's seven-day deadline. Request generations contain 97 observed background-pause diagnostics and 54 eventual completions after a pause. There are no explicit historical resume events, so zero observed resumes means uninstrumented, not no recovery. Attempt failures appeared in 44 requested generations; those generations are not thereby classified failed.

## Runtime and OTA attribution

The full evidence retains all 44 request-cohort launch combinations of OS, native version, runtime, OTA and embedded status. The largest runtime groups are shown here; short prefixes are labels only, and full identifiers remain in the JSON.

| Anchor platform/version | Runtime prefix | Requests | Completed | No start | Abandoned | Unknown |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| iOS 2.6.0 | `84dca13e7422` | 495 | 339 | 16 | 13 | 127 |
| Android 2.6.0 | `8733a10cad03` | 232 | 148 | 15 | 2 | 67 |
| iOS 2.7.0 | `e171c5f7e69a` | 139 | 129 | 2 | 4 | 4 |
| Android 2.5.0 | `154bc941c504` | 24 | 13 | 3 | 1 | 7 |
| iOS 2.5.0 | `b71bdb600c5a` | 13 | 7 | 1 | 0 | 5 |

One native version contains multiple runtimes. For example, the request cohort contains five distinct Android 2.7.0 runtime hashes. A semver-only comparison cannot identify the executing JavaScript or establish which clients receive this change. The other 33 request observations are retained in the complete release table, not discarded.

The current fix has no production receiving-update ID yet. When publishing or evaluating it, record the actual compatible native runtime, running OTA ID and embedded status, and evaluate that population separately. The historical groups above cannot be relabeled as recipients or used to certify the receiving release. [#7989](https://github.com/boardsesh/boardsesh/issues/7989) continues to own eligibility and the default decision.

## What the unexplained exits actually contain

The separate recent-health interval is UTC **[24 October, 21 November)**. The exact runtime/OTA/stage breakdown accounts for all 172 `Download Failed` events. They comprise 101 background-pause diagnostics, three disabled-download abandonments, 24 watermark refusals, twelve locks, five recognized decode failures, four recognized network failures and 23 `unknown` diagnostics. Counts are events, not independent downloads.

| Signature inside the 23 unknown diagnostics | Events | Observed stage | Disposition |
| --- | ---: | --- | --- |
| HTTP 416 | 11 | Download and grades download | Distinct `http-range` reason, bounded scheduled retries, then paging |
| Localized iOS decode descriptions | 4 | Download | Same bounded transport treatment as recognized English decode |
| Android connection reset/connect/abort descriptions | 5 | Download and grades download | Snapshot-specific transport normalization |
| Missing or unopenable grades artifact | 2 | Grades download/import | One explicit ENOENT gets `artifact-missing`; one ambiguous open failure remains unknown |
| SQLite `another row available` | 1 | Import | Preserve the exact cause; runtime/lock investigation remains necessary |

The iOS localized decode cases appear both in embedded 2.7.0 update `781bf1c3-961d-4bc5-9307-fc9fec6cb233` and OTA `db68ab2c-eeb5-e88d-d354-d83644c15efb`, under runtime `e171c5f7e69ad32d3915a5ae23155914015b5092`. Their Chinese/German descriptions bypassed the English-only matcher. The Android connection signatures appear under runtime `8733a10cad03453551ff474a116ef4858611f75b`, in embedded update `6c9e76c2-a105-4637-add6-66fbe7e74d23` and OTA `b07eeecb-660e-7715-14d3-29950361a55e`. Current source still routed those shapes into the two-failure structural-device budget; that demonstrated classification defect is fixed without broadening mutation replay policy.

HTTP 416 also appears in the embedded iOS 2.7.0 bundle above. The downloader already creates a fresh task and clears incomplete destinations. These records therefore do **not** establish stale resume data or a need to switch sessions. HTTP 416 remains unexpected even when it uses the transport retry budget; it must not become a free background pause or evidence the device is offline.

All twelve lock diagnostics and 23 of the 24 watermark refusals came from 2.6.0 runtime groups. One watermark refusal appears in the iOS 2.7.0 OTA above. This is older-fleet attribution, not proof the guarded condition cannot recur. Refusing an older scoped watermark protects rows and checkpoints; removing that guard would hide the symptom by risking catalogue corruption. Runtime lock recovery stays with [#6689](https://github.com/boardsesh/boardsesh/issues/6689)/[#6707](https://github.com/boardsesh/boardsesh/issues/6707).

## Remaining bounded verification

1. Run a receiving-runtime device check for HTTP 416 and localized decode recovery. Capture exact runtime/OTA, stage, response status and request generation; prove scheduled retry or paging reaches committed completion. A synthetic error fixture proves the recovery policy, not the CDN/native origin of the status.
2. Reproduce grades-artifact access/open failures while transfer/import overlap on the receiving Android runtime. Record whether the expected file existed immediately before verification and ATTACH, then correlate teardown/cache ownership. Only ENOENT establishes a missing path; the ambiguous open failure does not prove disappearance or who removed a file. Do not alter cache ownership based on that inference alone.
3. Before evaluating the matured lifecycle cohort, extend the export and tuple parser with `Offline Board Download Lifecycle` plus its request/attempt IDs, state, origin, request time and completion source. The saved four-event, 16-column query/parser reproduce this historical audit; they do not ingest those new fields unchanged. Reuse the seven-day classifier after that export update, keeping recovered legacy origins outside the new-request denominator and distinguishing deferred work, actual pauses/resumes and committed cached completions. Report remaining unknown delivery honestly.
4. Keep [#4310](https://github.com/boardsesh/boardsesh/issues/4310) and [#4394](https://github.com/boardsesh/boardsesh/issues/4394) as owners of Kilter completion latency and same-device transfer throughput. This audit neither duplicates their work nor treats completion-only timings as reliability evidence.
