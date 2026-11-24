# Boardsesh 2.7.0: release health and the Crew browse alert

Initial analysis: **2026-11-05 UTC**, completed-day cutoff **2026-11-05 00:00 UTC**;
its separate live incident check ran around **06:20 UTC**.
Follow-up: **2026-11-06 UTC**, completed-day cutoff **2026-11-06 00:00 UTC**.

## November 6 follow-up

Checked around **14:30 UTC on November 6**. Completed-day comparisons below use
**November 3–5 UTC**, with an exclusive cutoff of **November 6 00:00 UTC**.
The original November 5 snapshot remains below; historical totals have since
changed slightly, so its figures should be read as the earlier observation.

**The legacy alert still has a broken baseline. Android now needs a targeted
connect-to-first-light investigation before using this analysis to justify
further rollout expansion.** This is a recommendation, not a change to store
rollout settings; the current store rollout percentage was not checked.

### The extra completed day confirms the denominator problem

For November 5, the old alert recorded **0.750307287093942** and remained firing.
The internal-account-excluded diagnostic reproduces it as:

| Successful writes | All active events | Fresh picks | Navigation | Saves | Original ratio | Fresh-pick ratio |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 4,272 | 5,694 | 2,125 | 3,544 | 25 | 0.750 | 2.010 |

Navigation represents **62.2%** of the active-event denominator. Removing it and
saves again puts the diagnostic near the historical 2.05 baseline. The fresh-pick
ratio remains an event-volume diagnostic, not a conversion rate.
[Saved diagnostic](https://us.posthog.com/project/412845/insights/HPqz525k).

### Recent-build evidence now covers November 3–5

Native production, known internal accounts and emulators excluded. iPadOS is
folded into iOS. These are the same completed days for each comparison.

| Version / build / OS | Connecting people | Successful connects / attempts | Connecting sessions that lit | Board-active people | Successful writes / failures |
| --- | ---: | ---: | ---: | ---: | ---: |
| 2.6.0 / 18 / iOS | 330 | 1,435 / 1,447 (99.2%) | 495 / 500 (99.0%) | 330 | 10,178 / 0 |
| 2.7.0 / 13 / iOS | 21 | 75 / 79 (94.9%) | 25 / 25 (100%) | 21 | 388 / 0 |
| 2.6.0 / 2001310 / Android | 127 | 507 / 553 (91.7%) | 163 / 167 (97.6%) | 126 | 3,640 / 0 |
| 2.7.0 / 2001566 / Android | 14 | 38 / 45 (84.4%) | 12 / 14 (85.7%) | 11 | 288 / 0 |

Android's connection deficit is **7.2 percentage points** in this fixed three-day
comparison. Its connect-success sample now exceeds 20 attempts and 10 people.
Its first-light result still has only 14 connecting sessions, below that metric's
20-session floor. The dashboard therefore shows its connect-success rate but
keeps its first-light rate null.

iOS build 13 now has enough connecting sessions and people for the first-light
metric: all 25 connecting sessions had a subsequent observed write. Its
three-day connection rate is 4.2 points below the contemporary 2.6.0 iOS rate.
Those facts support a more specific interpretation than either blanket
"healthy" or blanket "broken."

The zero write-failure counts do not explain sessions without any write event.
A success rate computed only from recorded success/failure outcomes cannot
certify that every Put on board press reached the write stage.

[Connection evidence](https://us.posthog.com/project/412845/insights/0mwxxmDn)
and [write outcomes](https://us.posthog.com/project/412845/insights/z3JHNIVp):
select **November 3–5** to reproduce the table.

### Two Android sessions warrant a connect-handoff check

Two build-2001566 sessions had successful connections and deliberate Put on board
activations but no observed successful writes. None of the three activations
carried a crew session ID; the maximum reported participant count was zero. This removes the
obvious alternate-controller explanation from the captured event context.

| Board | Put-on-board activation | Successful connect | Observed write outcomes |
| --- | --- | --- | --- |
| Tension | Nov 4, 14:37:30.605 UTC | Nov 4, 14:37:42.715 UTC | No success, failure or skipped-write event |
| Kilter | Nov 5, 01:10:20.856 and 01:25:25.011 UTC | Nov 5, 01:15:13.927 and 01:25:33.606 UTC | No success, failure or skipped-write event |

There were also no `BLE Implicit Relight Suppressed` events in those sessions.
The Tension activation preceded its connection by about 12 seconds. The last
Kilter activation preceded its second connection by about 9 seconds. Do not
describe these as proven failed writes over an already-live connection.

The next focused check is **Put on board → connect/reconnect → first light on
Android**, including first-connect confirmation and app/background timing.
The event evidence does not establish a code defect, failed physical LEDs or
why a write outcome is missing. No recording or hardware reproduction was used.

### The iOS incidents remain concentrated

All **39** empty picker observations on November 5 still belong to the same
Tension session, from **04:21:39 to 06:02:23 UTC**. They did not expand into
39 different affected people. The full day's build-13 picker sample contained
50 observations from 12 people.

The four new non-cancelled iOS connection failures all came from **one MoonBoard
session**, between **18:08:18 and 18:15:24 UTC**. That same session and board also
recorded nine successful connections and 19 successful writes, with its last
write at **18:15:32 UTC**. This was a session with retries and subsequent observed
lighting, not evidence of four different people being unable to connect.

One build-13 iOS person had a single `paint_timeout` on the play surface at
**18:00:01 UTC**. That updates the initial snapshot's absence of foreground
render failures; it does not by itself establish a rendering regression.

### Live rolling watch: keep the window and build differences explicit

A forced refresh of the existing
[seven-day alert source](https://us.posthog.com/project/412845/insights/dZeLB6pv)
around 14:27 UTC returned:

| OS | Connect-success deficit | First-light deficit | Empty-picker rise |
| --- | ---: | ---: | ---: |
| Android | 4.7 points | 13.5 points | -9.9 points |
| iOS | 8.1 points | -0.6 points | 29.3 points |

Positive deficits mean the release performed worse. The source's nonzero
Android first-light deficit passes its aggregate sample gates and exceeds its
3-point threshold. The iOS connect and empty-picker comparisons also exceed
their configured thresholds. These are **live pooled-version warnings**: they
include the current day, older release builds and versions 2.7.0 and above.
They do not isolate build 2001566, build 13 or one OTA.

In particular, the completed-three-day Android connect deficit of 7.2 points
does **not** reproduce the rolling-seven-day connect deficit of 4.7 points.
Do not substitute one window for the other or claim the latter crossed 5 points.

All four connection alerts were still **disabled** when rechecked. No alert,
threshold, dashboard definition or rollout setting was changed in this follow-up.
The dashboard already incorporates the newer completed day.

## Decision (initial November 5 snapshot)

**The 0.66 alert is arithmetically correct, but its historical threshold no longer measures release health.**
Navigation now adds thousands of events to its denominator. On November 4,
removing navigation and climb saves changes the diagnostic ratio from **0.662 to 2.018**.

**The evidence does not show a broad collapse in board use. It is too early to declare 2.7.0 fully healthy.**
Weekly successful board writes increased 6.4%, and observed people lighting climbs
increased 7.5%. Those fleet totals mostly describe 2.6.0 binaries, including newer OTA code.
Recent iOS build 13 looks promising; Android build 2001566 needs attention and more people.

Use the new [Boardsesh 2.7 release health dashboard](https://us.posthog.com/project/412845/dashboard/2306944).
The original alert, its threshold, the four existing connection alerts and release rollout settings were left unchanged.

## What the alert actually measures

The [saved insight](https://us.posthog.com/project/412845/insights/TA8ofc3g)
divides the **count of `Climb Sent to Board Success` events** by the **count of all
`Set Active Climb` events**, daily. It filters native production, combines versions,
and has `filterTestAccounts: false`. It does not match a pick to a write.

Its description dates the baseline to the three weeks before the October 19 crew
browse rollout: 1.60–2.45, approximately 2.05. Its lower threshold is 1.55.
The [alert](https://us.posthog.com/project/412845/alerts?alert_type=insights&alert_id=01a15231-bb01-0000-a12a-94c0a3320243)
checked November 4 on November 5 at 06:00 UTC and recorded
**0.6619392793360647**, with no evaluation error. It began breaching for October 31.

A ratio above 1 was already possible: one pick can lead to multiple writes,
including relights or writes by connected phones. This is an event-volume
diagnostic, not a conversion or delivery-success rate.

The concern about the alert is justified, with one mathematical correction:
**fewer Set Active Climb events alone would increase this ratio**. The observed
fall primarily reflects a larger denominator after navigation instrumentation.
Preview-first behavior can also reduce the numerator by making lighting deliberate;
that is a plausible behavioral effect, not an isolated causal estimate here.

## Why the baseline broke

Two changes must be separated:

1. **Navigation telemetry expanded.** Next and Previous now emit `Set Active Climb`,
   with `trigger = next`, `previous` or `rest_timer`. The first such events in this
   analysis appear on October 29; volume grows sharply from October 31.
2. **Browsing and lighting separated.** A preview does not commit a climb to the
   wall. Put on board emits `trigger = put_on_wall`; selections during a drive can
   retain a null or navigation trigger. A put_on_wall-only count is not comparable
   with the older mostly-null-trigger count.

The event contract is documented in [growth metrics](./growth-metrics.md#dates-to-annotate-in-posthog).
The implementation emits picks and navigation from
[queue-provider.tsx](../packages/mobile/src/providers/queue-provider.tsx).
The preview-first behavior is recorded under November 2 in [CHANGELOG.md](../CHANGELOG.md).

### November 4 reconstruction

Native production, internal cohort 295337 excluded:

| Quantity | Count |
| --- | ---: |
| Successful board writes | 6,301 |
| All Set Active Climb events | 9,519 |
| Next / Previous / rest timer | 6,352 |
| Climb saves | 44 |
| Fresh picks: trigger absent/null or put_on_wall | 3,123 |

Navigation accounts for **66.7%** of the denominator.
`6,301 / 9,519 = 0.662`; `6,301 / 3,123 = 2.018`.
The internal-account exclusion happens to leave this day's alert value unchanged.

| UTC day | Writes | All active events | Fresh picks | Navigation | Original ratio | Fresh-pick ratio |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Oct 28 | 4,578 | 2,083 | 2,079 | 0 | 2.198 | 2.202 |
| Oct 29 | 4,387 | 2,133 | 2,048 | 28 | 2.057 | 2.142 |
| Oct 30 | 3,348 | 2,126 | 1,958 | 151 | 1.575 | 1.710 |
| Oct 31 | 3,802 | 3,163 | 2,025 | 1,123 | 1.202 | 1.878 |
| Nov 1 | 4,906 | 4,924 | 1,907 | 2,936 | 0.996 | 2.573 |
| Nov 2 | 4,702 | 5,822 | 2,769 | 3,020 | 0.808 | 1.698 |
| Nov 3 | 5,288 | 6,773 | 2,609 | 4,111 | 0.781 | 2.027 |
| Nov 4 | 6,301 | 9,519 | 3,123 | 6,352 | 0.662 | 2.018 |

The adjusted ratio is useful for diagnosing the break. It is **not a replacement
release gate**: writes can repeat, picks need not imply a Bluetooth connection,
and previews, spray walls and crew controllers do not have a one-to-one mapping
between local picks and local writes.

[Executable diagnostic and query](https://us.posthog.com/project/412845/insights/HPqz525k).

## Is board use still working?

### Whole-fleet outcomes

Two non-overlapping seven-day UTC windows, native production, known internal
accounts excluded. Unique people are counted independently over each whole window.

| Measure | Oct 22–28 | Oct 29–Nov 4 | Read |
| --- | ---: | ---: | --- |
| Successful board writes | 30,773 | 32,734 | +6.4% |
| People with a successful board write | 761 | 818 | +7.5% |
| Recorded board-write failures | 10 | 6 | No observed increase |
| Successful Bluetooth connects | 4,186 | 4,511 | +7.8% |
| Failed connects, cancels excluded | 213 | 151 | Fewer recorded failures |
| All Set Active Climb events | 12,995 | 34,460 | +165.2%; definition changed |
| Fresh picks | 12,909 | 16,439 | +27.3% |

These are reassuring fleet observations, not proof that the release caused
improvement. Usage, users, consent, OTA adoption and builds all vary between windows.

The denominator change is mainly visible on **2.6.0**: on November 4 those
binaries produced **5,791 writes and 9,172 active-climb events**. On October 28
they produced **4,070 writes and 1,692 active-climb events**.
An OTA preserves `$app_version`, so a version-only comparison misses the changed
experience. Use `$app_build`, `ota_update_id`, OS and dates together.

[Daily board-active people](https://us.posthog.com/project/412845/insights/xSBJR2c0)
and [observed build/OTA exposure](https://us.posthog.com/project/412845/insights/aEzs7fKr).

### Recent builds: November 3–4

These rows compare the same two completed UTC days. iPadOS is folded into iOS.
Connection attempts exclude user cancellations. First light means a successful
write at or after the first successful connection in the same person's app
session, version and build; it is not a count of successful individual connects.

| Version / build / OS | Connecting people | Successful connects / attempts | Connecting sessions that lit | Board-active people | Writes / failures |
| --- | ---: | ---: | ---: | ---: | ---: |
| 2.6.0 / 18 / iOS | 249 | 930 / 941 (98.8%) | 339 / 342 (99.1%) | 251 | 7,537 / 0 |
| 2.7.0 / 13 / iOS | 8 | 21 / 21 (100%) | 10 / 10 (100%) | 8 | 188 / 0 |
| 2.6.0 / 2001310 / Android | 102 | 384 / 418 (91.9%) | 123 / 125 (98.4%) | 103 | 3,033 / 0 |
| 2.7.0 / 2001566 / Android | 7 | 21 / 25 (84.0%) | 7 / 8 (87.5%) | 6 | 170 / 0 |

**iOS:** encouraging successful writes and first light, with only eight connecting people.
All nine non-cancelled iOS 2.7.0 connection failures in the completed seven-day
window came from older builds 7 and 8, one person on each build.
Pooling all 2.7.0 builds therefore makes build 13 look worse than its observed record.

**Android:** build 2001566's connect rate is **7.9 percentage points below** the
contemporary 2.6.0 Android row. Its four failures comprise three
`connect_failed` events from three people and one `unavailable` event.
One of eight connecting sessions had no observed subsequent write.
This is a real signal to inspect, but seven people cannot establish a release-wide regression.

Neither recent release build meets the documented **10-person** evidence floor;
neither first-light sample has **20 connecting sessions**. The rates above are
descriptive fractions. The new scorecards leave gated rates **null**, rather than
showing 0 or implying a quiet alert.

There were no `Board Render Failed` events on `play` or `full` surfaces from
2.7.0 during November 3–4. Its recorded render failures in that interval were
prefetch hold-matching failures. That does not establish crash-free operation:
native crash telemetry, unseen renders and physical LED output were not verified.

[Connection evidence by build](https://us.posthog.com/project/412845/insights/0mwxxmDn)
and [writes, drive drops and foreground render issues](https://us.posthog.com/project/412845/insights/z3JHNIVp).

## November 5 incident (original live check)

The live check around November 5, 06:20 UTC found **39 empty picker observations**
from **one person in one app session**, on a physical iOS device running
**2.7.0 build 13**, looking for a **Tension** board. All carried
`phoneNeverConnected = true`. They occurred from **04:21:39 to 06:02:23 UTC**.

There were 41 iOS 2.7.0 picker observations in that current-day check: the other
two, for Kilter and MoonBoard, were not empty. Thus the empty share is **39/41**,
but it does not represent 39 independent people encountering a problem.

Inspect this session's picker flow and available replay before deciding whether
it reflects unavailable nearby hardware, repeated opening, a capture issue or a
discovery defect. The cause is not established. No personal identifiers or replay
URLs are included in this report.

The existing [connection watch](https://us.posthog.com/project/412845/dashboard/2293063)
includes the current day. A forced refresh around 06:18 UTC returned a
**37.5-point iOS empty-picker rise** and **10.7-point iOS connect-success drop**
against 2.6.x. The former is heavily affected by this one session; the latter
mixes older failing builds with build 13. Android's connect-success drop was
5.6 points. These rolling readings must not be substituted for the fixed windows above.

All four connection alerts were **disabled** when inspected. Their
`Not firing` state is not evidence that the release passed. The old SQL also
returns zero below its volume floor, so a zero is not necessarily a measured
healthy rate. [Existing hold rule](./mobile-store-release.md#phased-release-hold-at-5).

## Better release monitoring

The [new dashboard](https://us.posthog.com/project/412845/dashboard/2306944)
contains seven insight tiles plus an interpretation card:

| Tile | What it answers |
| --- | --- |
| Connection and first-light evidence by build | Are attempts and connecting sessions succeeding, with enough people? |
| Board writes, drive drops and foreground render issues | Are actual write outcomes or visible rendering getting worse? |
| People lighting a climb each day | Are observed climbers still reaching the core outcome? |
| Existing connect-success chart | When did connect behavior change on each version and OS? |
| Set Active Climb event mix | How much of the denominator is navigation, picks or saves? |
| Legacy alert diagnostic | Does the ratio drop survive removing navigation and saves? |
| Build and OTA exposure | Which binaries and OTA bundles produced the observations? |

The default window covers completed UTC days. SQL insights use `{filters}` so
the dashboard date picker changes their window; they also exclude the current
UTC day explicitly. SQL scorecards exclude known internal people and emulators,
group by version/build/OS, and show raw counts even when a rate lacks evidence.
The scorecards and exposure table cover 2.6.0 and 2.7.0; the legacy ratio
diagnostic covers all versions, matching the original alert's version scope.
Typed trends exclude known internal people; their production population can
still contain QA or TestFlight traffic. OTA exposure lists at most 100 groups,
and people overlap between groups.
The reused connection trend is descriptive: it can display zero when a day
has no attempts. Use the scorecard counts and gated rates for decisions.

These are **derived diagnostic definitions**, not approved catalog metrics.
The project's governed metric catalog was empty at analysis time.

### Alert recommendation

1. **Retire the 1.55 threshold as a rollout decision signal.** Preserve the old
   insight for diagnosis; do not merely lower its threshold to yesterday's value.
2. **Use connection and first-light outcomes per OS and shipped build.**
   Start with the existing hold rule: more than a 5-point connect-success drop
   or 3-point first-light drop against a comparable store baseline.
3. **Require at least 20 observations and 10 release people for each measure.**
   First light needs 20 connecting sessions. Require baseline volume too;
   missing evidence must mean unknown, never healthy.
4. **Keep incident detection alongside fleet gates.** Investigate the single
   Tension picker session and Android 2001566 now, even while release samples
   remain too small for a fleet conclusion.
5. **Decide promotion after 48 hours of measured stability with sufficient volume.**
   A disabled alert, zero produced by a volume guard, or immature sample cannot
   satisfy the existing hold rule.

No alert or rollout changes were made as part of this analysis.

## Evidence limits

Production native analytics includes TestFlight and some QA traffic. Excluding
cohort 295337 does not identify every internal account; excluding emulators does
not identify every test. `ota_branch` can be absent at launch, and one production
event group even reported `pr-staging`. Do not label these counts verified store adoption.

PostHog observes the analytics-enabled population. People counts are neither all
customers nor canonical DAU; [the repository's active-user contract](./growth-metrics.md#active-users-canonical-dau-wau-and-mau)
uses backend snapshots instead. Consent withdrawal and deletion can change historical results.

A successful write is app-reported completion, not external confirmation that
every intended LED lit. Same-person session first light can miss a crew action
performed by another controller. No randomized comparison, mature release-specific
retention cohort, store rollout-state check or native crash-free-session analysis
was performed. The evidence supports **replacing this alert's interpretation**,
while keeping **Android connection health and the concentrated iOS discovery
incident under investigation**.

## Reproduce the alert diagnosis

Run the following in PostHog project 412845. The bounds are half-open UTC
timestamps and reproduce the completed-day diagnostic in this report.
The saved dashboard insight carries the same calculation with dynamic date filters.

```sql
SELECT
    toDate(timestamp) AS day,
    countIf(event = 'Climb Sent to Board Success') AS sends,
    countIf(event = 'Set Active Climb') AS all_active,
    countIf(
        event = 'Set Active Climb'
        AND coalesce(toString(properties.trigger), '') IN ('', 'put_on_wall')
    ) AS picks,
    countIf(
        event = 'Set Active Climb'
        AND properties.trigger IN ('next', 'previous', 'rest_timer')
    ) AS navigation,
    countIf(
        event = 'Set Active Climb' AND properties.trigger = 'climb_saved'
    ) AS saved,
    round(sends / nullIf(all_active, 0), 3) AS original_ratio,
    round(sends / nullIf(picks, 0), 3) AS pick_ratio
FROM events
WHERE timestamp >= '2026-10-22'
    AND timestamp < '2026-11-05'
    AND event IN ('Climb Sent to Board Success', 'Set Active Climb')
    AND properties.$lib = 'posthog-react-native'
    AND properties.environment = 'production'
    AND person_id NOT IN COHORT 295337
GROUP BY day
ORDER BY day
LIMIT 30
```

The saved scorecard insights expose their executable SQL, population filters
and denominators. To reproduce the recent-build table, select November 3–4
on the dashboard. Changing the dates does not change which build or OTA actually ran.

The whole-fleet weekly headline includes legacy versions that the 2.6/2.7
scorecards exclude. Reproduce it with this separate query; do not sum
per-build or per-day unique people to obtain a weekly unique count.

```sql
SELECT
    if(timestamp < '2026-10-29', 'Oct 22–28', 'Oct 29–Nov 4') AS period,
    countIf(event = 'Climb Sent to Board Success') AS sends,
    uniqIf(person_id, event = 'Climb Sent to Board Success') AS board_people,
    countIf(event = 'Set Active Climb') AS all_active,
    countIf(
        event = 'Set Active Climb'
        AND coalesce(toString(properties.trigger), '') IN ('', 'put_on_wall')
    ) AS picks,
    countIf(event = 'Climb Sent to Board Failure') AS write_failures,
    countIf(event = 'Bluetooth Connection Success') AS connects,
    countIf(
        event = 'Bluetooth Connection Failed'
        AND coalesce(toString(properties.failureReason), '') != 'user_cancelled'
    ) AS connect_failures
FROM events
WHERE timestamp >= '2026-10-22'
    AND timestamp < '2026-11-05'
    AND event IN (
        'Climb Sent to Board Success', 'Climb Sent to Board Failure',
        'Set Active Climb', 'Bluetooth Connection Success',
        'Bluetooth Connection Failed'
    )
    AND properties.$lib = 'posthog-react-native'
    AND properties.environment = 'production'
    AND person_id NOT IN COHORT 295337
GROUP BY period
ORDER BY period
LIMIT 5
```

