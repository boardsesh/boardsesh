# iOS simulator performance after the HIG changes — 9 October 2026

The candidate used more process CPU during the browsing sequence in both replay
cohorts. The explicit no-event control measured **5.60 → 6.98 CPU seconds
(+24.6%)**, while settled Home memory fell **347.4 → 288.3 MiB (−17.0%)**.
This is a CPU regression signal worth investigating, not a clean performance
pass. Startup is inconclusive because host contention differed substantially.
The measurements do not establish that a particular HIG change caused the cost.

## Comparison and controls

| Setting | Value |
| --- | --- |
| Baseline | `4601cb1f2e2cb40502c486f879732d9d32f328cf`, before the HIG/accessibility series |
| Candidate | `58c2b12be4ba1071cdde01f2793d40b69565ec83` |
| Device | Same iPhone 17 simulator, iOS 26.5 |
| Build | Source-built Release, embedded Hermes bundle, OTA disabled |
| Runtime | Expo 57.0.18, React Native 0.86.3, React 19.2.3 |
| Content | Same recorded GraphQL responses, dark theme, en-US, screenshot mode |
| Host | 18 CPU cores, 128 GiB RAM; concurrent unrelated builds |

The source interval also includes privacy and history changes. This is a
comparison of these complete revisions, rather than an isolated HIG patch.
Executable UUIDs, executable/bundle hashes and OTA configuration were verified
against the installed app before and after each phase. Installation preserved
the existing warmed data; there was no uninstall, keychain reset or data wipe.
Both builds had the same startup collector enabled. Release profiling follows
the [React Native profiling guidance](https://reactnative.dev/docs/profiling).

Each backend cohort ran baseline before candidate, without randomized order.
Browsing started in the tenth validated startup process, with two excluded
warmup rounds. Each measured round used matching automation inputs and asserted
loaded content: Home, Climbs scrolling and short swipes, Home, pre-start Session,
Discover, Profile Logbook scrolling, Progress, expanded native tabs and Home.
Layout differences mean matching coordinates do not guarantee matching rendered
work. In particular, a Logbook swipe reached a baseline row but a candidate
group heading. These rounds do not isolate the new Logbook reveal gesture.

## Browsing results

Values below are nearest-rank medians. CPU seconds cover the entire sequence,
including background work and automation/assertion gaps; they are not navigation
latency. Footprint is a settled Home snapshot, not peak memory.

| Cohort | Rounds per build | CPU seconds, baseline → candidate | Footprint MiB, baseline → candidate |
| --- | --- | --- | --- |
| Original fixture miss, diagnostic | 5 | 6.08 → 7.21 (+18.6%) | 348.4 → 276.9 (−20.5%) |
| Explicit no-event privacy control | 3 | 5.60 → 6.98 (+24.6%) | 347.4 → 288.3 (−17.0%) |

The explicit control's ordered samples are:

| Measurement | Baseline | Candidate |
| --- | --- | --- |
| Whole-sequence CPU seconds | 5.86, 5.52, 5.60 | 7.15, 6.98, 6.92 |
| Settled footprint MiB | 327.1, 347.4, 349.9 | 270.8, 288.3, 298.8 |
| Settled idle CPU, median / maximum, percent of one core | 1.19 / 1.47 | 1.48 / 1.97 |

Every candidate CPU sample exceeded every baseline sample in this small control.
Both footprints increased across repeated browsing: +22.8 MiB baseline and
+28.0 MiB candidate from first to last measured round. Lower observed memory
does not demonstrate the absence of a long-session leak. Short idle CPU samples
changed direction between cohorts and do not establish an idle regression.

### Privacy replay scope

The original archive lacked `PrivacyChanged`. The replay server sent a GraphQL
error in a subscription `next` payload; the stream remained open. The candidate
privacy bridge invalidated caches in response. This was not a reconnect loop.
The original five-round cohort is diagnostic: its replay context was not
explicitly captured at run time.

The explicit control used the same archive with `PrivacyChanged` held open and
silent. Production sends an initial `{ privacyChanged: true }` event, which also
triggers revalidation. Therefore the quiet control omits normal initial privacy
work as well as the fixture error. It is a no-event isolation control, not a
production-equivalent privacy/startup test. The CPU increase persists in that
control, so the missing subscription fixture alone cannot explain the observed
increase. Common `SyncDeletions` fixture misses and 30-second retry cycles remained
in both builds; that source path was unchanged.

The replay helper now recognizes missing `PrivacyChanged` fixtures as passive,
with a socket handshake/ping/silence test. Recorded fixtures still take priority
and document/variable drift still fails. Tests of production initial invalidation
must supply its snapshot, as described in
[the fixture guide](mobile-screenshot-fixtures.md).

## Startup: no verdict

Each of four startup series completed ten authenticated, populated Home launches
after one excluded warmup. The span is `collector.loaded` to
`home.useful.commit`, measured on one JavaScript runtime clock. It excludes native
work before collector load and is not time to the first displayed frame.

| Cohort | Baseline median / maximum ms | Candidate median / maximum ms |
| --- | --- | --- |
| Original fixture miss | 472 / 499 | 555 / 652 |
| Explicit no-event control | 600 / 901 | 378 / 574 |

Initial candidate startup coincided with host load around 246; baseline was
around 12–20. The later control reversed the imbalance: baseline per-trial
one-minute load ranged 69.6–126.4, candidate 8.6–9.9. These incompatible conditions
prevent a startup regression or improvement conclusion. CPU measured at deferred
startup export includes native/background work and idle after Home; it is not
CPU consumed to the first frame. Ten-launch maxima are also nearest-rank p95,
but this sample size does not establish a population tail.

## Candidate gesture and board preview checks

A supplemental candidate-only run verified an actual Logbook row's **Edit entry**
reveal without invoking Edit or Delete. It also made 25 discrete board-look
changes across six presets with actual board art visible. Settled footprint was
284.5 MiB before, 284.7–284.9 MiB across five blocks, and 284.2 MiB after visually
returning Home. Custom was excluded; no Save/Continue action persisted the draft.
Returning Home does not prove the onboarding modal unmounted.

The preview needed one additional `SearchClimbs` response derived from the first
real climb in the same recorded configuration at 35 degrees. This copied fixture
was used only for the supplemental run. The original archive and all paired
measurements were unchanged. These checks support bounded settled memory in the
preview; they do not measure gesture peaks, animation FPS or dropped frames.

## Evidence and follow-up

[The measurement snapshot](ios-performance-hig-2026-10-09.json) contains ordered
samples, both backend contexts, source/artifact hashes, matching flow hashes,
startup outcomes and supplemental fixture provenance. Raw captures, screenshots,
native `sample` call graphs, identity checks and invalid attempts are retained
locally under `.boardsesh/perf-2026-10-09/`. Invalid and incomplete captures were
excluded. This sequence does not cover the separate 400-playlist stress test in
[the profiling guide](ios-profiling.md).

The simulator-targeted Instruments recording failed to report readiness. A
bounded default-Mac-target retry could not resolve the verified simulator app
PID. Both were excluded and dispatched no navigation workload. Native process
CPU and `sample` footprint captures are valid; no presentation FPS, hitch rate,
energy or real-device budget is established.

Source review retained virtualization, memoized rows and bounded effects. New
per-row gesture/action views are an attribution lead, not a measured hotspot;
native glass removal may affect memory/compositing too. The next useful test is
an isolated actual-row reveal/scroll comparison under equal host load, followed
by a physical-device frame and CPU trace. Do not revert a specific HIG change
based solely on these aggregate measurements.
