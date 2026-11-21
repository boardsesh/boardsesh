# Climbing experience epic: implementation and remaining release gates

Audit date: 21 November 2026. Epic: [#6238](https://github.com/boardsesh/boardsesh/issues/6238).
Source baseline: `2d6598f13a15058f0000619bab03fc13fc191a02`.
All times below are UTC, stated explicitly for reproducibility.

## Completion status

The [GitHub sub-issue graph](https://api.github.com/repos/boardsesh/boardsesh/issues/6238/sub_issues?per_page=100)
lists **18 direct children: 15 closed and 3 open**. The original issue-body
checklist omits seven later queue follow-ups and includes four workout cross-links;
it is not the complete child inventory.
The player-visibility foundation [#6279](https://github.com/boardsesh/boardsesh/pull/6279)
is merged too. The three open children are
[#6666](https://github.com/boardsesh/boardsesh/issues/6666) for the separate Now slot,
[#6273](https://github.com/boardsesh/boardsesh/issues/6273) for privacy and
[#2644](https://github.com/boardsesh/boardsesh/issues/2644) for analytics.
Keep the epic open until their remaining implementation and release gates have
dated evidence.

This audit checked merged PRs, current source and existing regression coverage.
It is not a new iOS/Android device acceptance run. No production configuration,
release, retention, erasure, drop rule or object deletion was changed.

## Merged feature evidence

| Child | Merged evidence | Current implementation or contract |
| --- | --- | --- |
| #6287: climb-row visibility | [#6369](https://github.com/boardsesh/boardsesh/pull/6369) | `packages/mobile/src/lib/climb-row-display.ts`, its preference store and row/settings tests |
| #6288: Recents shortcut | [#6542](https://github.com/boardsesh/boardsesh/pull/6542) | `pinnable-chips.ts`, pinned-chip storage and capsule tests |
| #6230: list/queue model | [#6540](https://github.com/boardsesh/boardsesh/pull/6540) | [List model](climb-lists-and-queue.md), real screenshots and `queue-list-model.test.ts` |
| #6289: Home and startup | [#6536](https://github.com/boardsesh/boardsesh/pull/6536), [#6546](https://github.com/boardsesh/boardsesh/pull/6546) | `app-entry-route.ts`, Home components and entry-route/Home tests |
| #6229: player ordering/actions | [#6554](https://github.com/boardsesh/boardsesh/pull/6554), [#6543](https://github.com/boardsesh/boardsesh/pull/6543) | Section-layout and player-button preferences; [climb-view options](climb-view-options.md) |
| #6290: active holds | [#6544](https://github.com/boardsesh/boardsesh/pull/6544) | Existing `ActiveHoldsSection.tsx`, shared `active-holds.ts` and frame/line/section tests |
| #6234: MoonBoard labels | [#6541](https://github.com/boardsesh/boardsesh/pull/6541) | `MoonBoardGridLabels.tsx`; theme, Mini and surface coverage |
| #6235: contributor guide | [#6535](https://github.com/boardsesh/boardsesh/pull/6535) | [Contributing to existing screens](contributing-to-screens.md) |
| #6664: named list playback | [#6671](https://github.com/boardsesh/boardsesh/pull/6671) | List context, end cards and explicit queue continuation |
| #6665: consistent list opening | [#6700](https://github.com/boardsesh/boardsesh/pull/6700) | Shared list-opening behavior and light-on-tap preference |
| #6667: preserve the queue | [#6702](https://github.com/boardsesh/boardsesh/pull/6702) | Playlist, For You and setter playback without implicit queue replacement |
| #6668: return to the list | [#6671](https://github.com/boardsesh/boardsesh/pull/6671) | Return navigation and retained list position |
| #6669: queue labels | [#6671](https://github.com/boardsesh/boardsesh/pull/6671) | History, Up next and Suggestions |
| #6670: playlist-load race | [#6671](https://github.com/boardsesh/boardsesh/pull/6671) | Preserve selection while the full playlist loads |
| #6242: privacy implementation | [#6254](https://github.com/boardsesh/boardsesh/pull/6254) | [Current privacy contract](privacy.md); release remains #6273 |

The following completed issues belong to #5399 and are cross-linked from #6238,
rather than direct children of this epic.

| Workout cross-link | Merged evidence | Current implementation |
| --- | --- | --- |
| #6291: workout screens | [#6380](https://github.com/boardsesh/boardsesh/pull/6380), [#6756](https://github.com/boardsesh/boardsesh/pull/6756), [#6835](https://github.com/boardsesh/boardsesh/pull/6835) | Existing setup, preview and stage-aware runner |
| #6231: limit bouldering | [#6756](https://github.com/boardsesh/boardsesh/pull/6756), [#6835](https://github.com/boardsesh/boardsesh/pull/6835) and linked issue history | Shared stage model, runner, rest and attempt outcomes |
| #6232: workout quality | [#6719](https://github.com/boardsesh/boardsesh/pull/6719), [#7816](https://github.com/boardsesh/boardsesh/pull/7816) and linked issue history | Per-block filters, candidate search tiers and [catalogue-depth contract](workout-catalogue-depth.md) |
| #6233: low-grade warm-up | [#6255](https://github.com/boardsesh/boardsesh/pull/6255) | Existing shared workout generator |

The accepted active-holds contribution is MoonBoard-only. Its merged scope does
not establish active-hold identities for Kilter or Tension. Broader workout work
continues under [#5399](https://github.com/boardsesh/boardsesh/issues/5399);
finishing this epic does not imply that separate epic is complete.

## Now slot: the additional open queue child

[#6666](https://github.com/boardsesh/boardsesh/issues/6666) implements the current
climb outside Up next. Its [26 October status](https://github.com/boardsesh/boardsesh/issues/6666#issuecomment-6408575083)
records merged design #6699, shared rules #6717, backend #6721, mobile #6769 and
Swift #6771. That historical status reported 100% client targeting while retaining
legacy server behavior for installed readers. Those observations are not fresh
rollout receipts.

| Remaining requirement | Evidence needed before closure |
| --- | --- |
| Reconnect compatibility | Resolve or explicitly account for the reported legacy-mode move replayed as a Now change after reconnect; the 60-second watchdog is not a regression test. |
| Native delivery | Establish that a publicly available compatible iOS binary contains the Swift slice, not just that its PR merged. |
| Device acceptance | Dated iOS/Android checks for separate Now, the stale-current hold and Replay from here. |
| Legacy cleanup | Prove two weeks at 100% and flat relevant telemetry before removing the legacy reducer, prune or feature flag. Preserve shipped-client compatibility. |

An Astra source audit confirmed the reconnect finding in the shared reducer.
A focused fix is being prepared: retire the unconfirmed move only when the queue
mode actually changes and recover from the authoritative server snapshot.
Same-mode updates must preserve a pending move. Legacy cleanup remains gated on
rollout and device evidence. No flag or server percentage was changed in this audit.

## Privacy: current public evidence and open gates

An independent Astra audit completed public artifact checks at
**2026-11-21 10:31:15 UTC**. It read the current R2 manifests and every referenced
artifact: 23 identity cores, 23 gzip cores, 21 grades files and one reference catalog.
All 46 core entries and 21 grades entries carried `privacyVersion: 1` with format 2.
The catalog retains its separate format-1 contract.

| #6273 gate | Evidence on 21 November | Still required |
| --- | --- | --- |
| Deployed enforcement | Public health served baseline `2d6598f13a`, deployment `4abe0c3c-53bf-4cec-9df7-4f9086ef930d`. [Matching migration/backend job](https://github.com/boardsesh/boardsesh/actions/runs/44893710262/job/136816409081). | Per-replica serving identity and anonymous/owner/follower/revoked audience tests. Health alone does not prove authorization. |
| New artifacts | All 68 decoded SQLite bodies passed integrity, metadata, declared tables/counts/sizes and scope checks. Each core representation contained 925,980 climbs and 958,290 stats, with zero linked-user, draft or spray rows and zero orphan stats. All 3,975,491 grades matched the relevant gzip core. Catalog tables matched metadata and omitted personal beta association columns. | Signed-origin comparison, full storage-checksum receipts and source-only ownership/provenance checks. Two compressed responses were transparently decoded by the edge, preventing storage-hash attestation for those responses. |
| Historical withdrawal | Both old Tigris format-1 manifests responded successfully. Anonymous HEADs on representative immutable identity, gzip, grades and catalog objects all returned HTTP 200 at 10:25 UTC. | A complete origin/object-version/CDN inventory, reviewed withdrawal scope, explicit approval before deleting stored objects, and origin-plus-edge denial receipts after withdrawal. |
| Installed readers | Existing format-1 readers fall back to authenticated paged sync for format 2. Source preserves legacy mutation compatibility. | An actual shipped iOS/Android reader matrix: cold fallback, existing downloads, logging, joining, legacy edits and sync load. Source review does not replace device evidence. |
| Controls and monitoring | No flag was changed during this audit; deployed flag state was not independently read back. | Enable controls only after preceding gates pass, then verify Settings, existing selections and monitoring. No forced setup screen is expected. |

The public scan covered **1,663,922,176 decoded bytes**, including both core
representations. Public hashes cannot establish identity with a signed origin.
Row-level checks cannot recover provenance columns omitted from an export.

The [migration retention clock](r2-migration-2026-10.md#retention-and-automation)
ended on 4 November 2026 at 02:12:59 UTC. That date explicitly does **not**
authorize deleting objects, buckets or credentials. Analytics activity-retention
approval is a different scope and does not authorize snapshot withdrawal.

Prepare the withdrawal as a concrete inventory: R2 and Tigris objects and versions
for identity, gzip, grades and catalog artifacts, plus cached aliases, previews and
CDN copies. Preserve non-public recovery where appropriate. Record each approved
origin and edge check without publishing historical object keys or personal data
in this public repository. Previously downloaded copies cannot be recalled.

Use today's [privacy contract](privacy.md#reads-live-updates-and-downloaded-copies)
for device testing. The obsolete privacy-event/token-refresh catalog wipe was
removed in #6411/#6545; preserving downloads across token refresh is intentional.
There is no privacy setup screen: the deprecated onboarding field always reads 1.

The audit also found that the signed snapshot verifier's count/metadata checks did
not assert the privacy marker or reject authored/draft rows. A focused validator
change is being prepared separately; it does not itself withdraw old artifacts.

## Analytics: verified progress and remaining work

The [19 October evidence ledger](https://github.com/boardsesh/boardsesh/issues/2644#issuecomment-6259849741)
supersedes several unchecked items in #2644's original body. An independent Astra
read-only audit refreshed the following evidence at **2026-11-21 10:29 UTC**.

| Area | Verified evidence | Remaining gate |
| --- | --- | --- |
| Daily aggregate snapshot | [PostHog project 412845](https://us.posthog.com/project/412845/events) contained exactly one event UUID for each of 37 counted days, 15 October–20 November inclusive. The manual first day was followed by 36 arrivals at 00:20 the next day. Latest ingestion: 21 November 00:20:11.233; DAU 656, WAU 2,721, MAU 5,234. | This scheduled snapshot check passes. It says nothing about the separate retention or erasure jobs. |
| Retention and erasure | The October ledger records approval for daily 60-day activity retention and exactly two retries. Its manual retention run deleted zero rows. One historical discovery still failed with HTTP 504 at 13/13 attempts; the other approved retry succeeded and its deletion request was accepted. [#6817](https://github.com/boardsesh/boardsesh/pull/6817) later bounded lookup memory. | Current scheduled retention results, the failed discovery's eventual result and downstream erasure receipts. The code fix and provider acceptance are not proof of erasure. No current backend job/retention readback was available. |
| Store availability | Compatible Android 2.7.0 was offered on the public [US](https://play.google.com/store/apps/details?id=com.boardsesh.app&gl=US&hl=en_US) and [Australian](https://play.google.com/store/apps/details?id=com.boardsesh.app&gl=AU&hl=en) listings on 21 November. All eleven tagged Android 2.7.0 builds contain #6359; the approved release/build anchors resolve to `38aa9d18976eaa96d98118b2201a9190deab0b14`. | The listing does not expose versionCode or first availability. A conservative full 30 days from this observation ends **21 December 10:29 UTC**; earlier dated availability proof can establish an earlier bound. The historically verified iOS deadline remains **14 November 00:26:59 UTC**. |
| Legacy ingestion | A 19 November screen-event preview found 386 iOS and 156 Android events from seven known pre-consent binary cohorts among 2,705 production app screen events. [Transformation readback](https://us.posthog.com/project/412845/pipeline) listed one enabled GeoIP transformation. | Preview all affected event classes and replay separately, establish each platform's grace period, obtain the recorded explicit confirmation and verify old/current/operational traffic before enabling a cutoff. The screen sample is not a complete rule preview. |
| Release QA and Sentry | [#6607](https://github.com/boardsesh/boardsesh/pull/6607) fixed browser account identification. | Dated physical iOS/Android release-device evidence, authenticated deployed Expo auth/replay/US-default capture checks, and Sentry organization/project IP-storage readbacks remain open. Connected tools did not expose the Sentry admin settings. |

Never select a legacy cohort by numeric build number alone: current and old iOS
versions both used build number 13 in the inspected sample. Use platform plus exact
version/build and distinguish product capture, recordings and permitted operations.

Reproduce the scheduled aggregate check in the
[PostHog SQL editor](https://us.posthog.com/project/412845/sql), without account identifiers:

```sql
SELECT
  properties.day,
  count(),
  uniqExact(uuid),
  min(created_at),
  max(properties.dailyActiveUsers),
  max(properties.weeklyActiveUsers),
  max(properties.monthlyActiveUsers)
FROM events
WHERE event = 'Active Users Snapshot'
  AND timestamp >= '2026-10-15'
  AND timestamp < '2026-11-21'
  AND distinct_id = 'system:active-users'
  AND properties.environment = 'production'
  AND properties.countSource = 'user_activity_days'
GROUP BY properties.day
ORDER BY properties.day
```

## Recorded decisions

1. Preserve the merged features and their current defaults. Resolve stale tracking
   and documentation rather than rebuild completed screens or revive a second layout.
2. Use the actual 18-child graph and keep #6666, #6273, #2644 and #6238 open.
   Queue rollout, public legacy artifacts, operational evidence and release-device
   checks prevent a defensible completion claim.
3. Correct contributor guidance to target `main` for both native and JavaScript
   PRs, reference the current locale registry, and label completed examples honestly.
4. Harden snapshot validation in a focused follow-up. Preserve the historical
   baseline and catalog contracts, and state which provenance checks need the source.
5. Do not merge any PR. Prepare reviewable changes and sanitized evidence; deletion,
   ingestion cutoffs and production release gates retain their specific approvals
   and compatibility checks.
