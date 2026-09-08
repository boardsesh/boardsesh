# iOS performance follow-up — 8 September 2026

This follow-up addresses the five findings in [the original audit PR](https://github.com/boardsesh/boardsesh/pull/5323). Measurements use a dedicated iPhone 17 Pro simulator on iOS 26.5, local fixtures, and unchanged readiness gates and cache limits. Debug observations attribute JavaScript/React work; they are not native FPS or production performance budgets.

## Controlled setup

The baseline is fetched main `0691f93b` plus the audit document and startup instrumentation (capture checkout `fef7a08ec`). Instrumentation was installed before baseline capture. The candidate adds the reviewed Discover and feedback changes. Its only collector difference is a corrected description of the clock: RN `performance.now()` is monotonic uptime here, so compare differences within each run, never absolute values between processes or against host timestamps.

The owned simulator is `EF3B3CC1-A130-4254-82A6-6ADCA7423106`, named **Boardsesh Performance Comparison 2026-09-08**. A shared simulator lease spans installation, navigation, screenshots, and profiling. No other simulator, Metro process, app data, or keychain was reset. Native builds and test suites finished before timed captures.

Fixtures contain 200 owned and 200 community playlists, each containing twelve real Tension climbs. Fixture content hash: `837d9e4ee0c9546cb60a46c7c2c32150328334efc145459afdde70e2bf605014`. The local backend uses port 8198. Screenshot-mode automatic login, board selection, Aura rendering, and initial simulated wall are identical. Community popular/recent streams overlap, so their first merged page contains ten unique cards; pagination reaches all 200.

Both Release apps are ordinary embedded builds from fresh dedicated native projects, with the same native fingerprint `3a1516787db2fe5b033b3a1462ba518dbee5bbee`. Debug uses a fresh launcher/menu-free project with supported Expo autolinking exclusions. The same validated Debug executable is reused for candidate JavaScript. The candidate temporary checkout hit `FSEventStreamStart` before recording; its successful Debug run uses the main workspace's existing Watchman watch and the same candidate source. The failed attempts remain explicitly invalid. Binary identities and source patch hashes are retained with the captures.

## Finding dispositions

| Finding | Disposition | Evidence / remaining work |
| --- | --- | --- |
| Stable Discover actions | Fixed | Callback-only card renders: 780 → 0 in five measured tab loops. |
| Growing Discover shelves | Fixed | Both shelves mount seven cards at 20/100/200 loaded; real gestures request one page. |
| Closed feedback subscriptions | Fixed | Closed form renders: 20 → 0; native drafts and dismissal pass. |
| Startup attribution | Investigated without an established defect | Local phase marks added; initialization order and gates preserved. See distributions below. |
| Repeatable profiling setup | Fixed | Owned simulator/build locks, valid binary identities, completed Debug tracing, stale-capture rejection, and local artifacts. OS watcher failure is retained as an invalid attempt. |
| Retained-object / phone performance attribution | Explicitly awaiting device validation | Incomplete simulator allocation capture establishes no leak. Native FPS, energy, and allocation ownership remain unmeasured. |

## Discover and feedback

Two warm-up Home → Climbs → Discover → Profile loops preceded five measured loops in each Debug runtime. All twenty measured destinations were verified.

| Metric | Baseline | Candidate |
| --- | ---: | ---: |
| Exact PlaylistCard renders caused only by action props | 780 | 0 |
| Closed FeedbackSheet renders | 20 | 0 |
| PlaylistCard self render time | 61.382 ms | 0 ms |
| Closed FeedbackSheet self render time | 14.821 ms | 0 ms |
| Largest React commit | 40.514 ms | 19.390 ms |
| All React commits | 115 | 125 |
| Owned shelf mounted cards at 20 / 100 / 200 loaded | 20 / 100 / 200 | 7 / 7 / 7 |
| Community shelf mounted cards at 20 / 100 / 200 loaded | 20 / 100 / 200 | 7 / 7 / 7 |

Zero renders means no measured updates after warm-up, not an empty screen. Native screenshots confirm visible cards. The candidate still has the fixed eight-card smart shelf and capped pinned grid. During a real horizontal gesture, the recycler used eight mounted cards while showing a different portion of the shelf.

Maximum long tasks on each of the five Discover visits were **133.56, 139.28, 122.98, 138.38, 132.26 ms** before and **74.79, 78.84, 79.70, 80.92, 61.89 ms** after. Medians were **133.56 → 78.84 ms**; nearest-rank p95 values **139.28 → 80.92 ms**. This is one controlled Debug attribution comparison, not a production latency promise.

Maximum JS callback gaps by Discover visit were **142.28, 147.96, 131.54, 146.87, 140.44 ms** before and **84.34, 87.28, 88.90, 89.00, 71.24 ms** after. These are JS callback gaps, not displayed-frame intervals.

Mounted-card counts are actual React fibers in the native app. For this capacity probe, the existing pagination action is called once per settled page; it does not substitute for gesture testing. The final candidate probe asserts and records the actual loaded length at each target before counting mounted cards. Exact `PlaylistCard` matching excludes new adapters and list wrappers. No playlists are capped or removed.

### Maximum JS long task per measured visit (ms)

| Tab | Baseline visits 1–5 | Candidate visits 1–5 | Baseline p50 / p95 | Candidate p50 / p95 |
| --- | --- | --- | ---: | ---: |
| home | 55.97, 75.39, 76.51, 98.18, 79.04 | 75.45, 75.61, 75.55, 72.55, 74.63 | 76.51 / 98.18 | 75.45 / 75.61 |
| climbs | 76.81, 78.78, 76.83, 56.79, 70.94 | 75.90, 75.14, 75.37, 74.98, 76.01 | 76.81 / 78.78 | 75.37 / 76.01 |
| discover | 133.56, 139.28, 122.98, 138.38, 132.26 | 74.79, 78.84, 79.70, 80.92, 61.89 | 133.56 / 139.28 | 78.84 / 80.92 |
| profile | 73.17, 72.35, 71.00, 72.52, 73.10 | 69.75, 70.35, 55.06, 72.64, 69.30 | 72.52 / 73.17 | 69.75 / 72.64 |

### Maximum JS callback gap per measured visit (ms)

| Tab | Baseline visits 1–5 | Candidate visits 1–5 | Baseline p50 / p95 | Candidate p50 / p95 |
| --- | --- | --- | ---: | ---: |
| home | 67.80, 84.29, 84.55, 105.45, 87.78 | 85.98, 83.14, 84.22, 80.00, 82.85 | 84.55 / 105.45 | 83.14 / 85.98 |
| climbs | 85.21, 86.42, 85.80, 63.47, 79.74 | 84.61, 83.58, 83.95, 82.66, 84.40 | 85.21 / 86.42 | 83.95 / 84.61 |
| discover | 142.28, 147.96, 131.54, 146.87, 140.44 | 84.34, 87.28, 88.90, 89.00, 71.24 | 142.28 / 147.96 | 87.28 / 89.00 |
| profile | 82.06, 80.44, 80.55, 80.16, 81.68 | 77.32, 78.42, 61.76, 81.48, 77.94 | 80.55 / 82.06 | 77.94 / 81.48 |

## Startup

Ten process-cold, warm-cache launches per Release build terminate only the app. A useful Home commit must represent content, empty, offline, or error output; loading placeholders do not qualify. The collector writes one bounded local artifact after a one-second export delay. The host observation includes that delay, polling, and `simctl` overhead, so it is not time to first frame. Root-to-Home and gate spans use only the JS clock.

All twenty original launches reached authenticated Home content with ready fonts/SQLite/splash marks and no SQLite background recovery. Percentiles use nearest rank; with ten samples, p95 equals the maximum.

| Measurement | Baseline p50 | Candidate p50 | Difference | Baseline p95 | Candidate p95 |
| --- | ---: | ---: | ---: | ---: | ---: |
| Host: local export observed | 3046.46 | 3658.19 | +611.73 | 3110.52 | 3784.03 |
| JS: collector → useful Home | 333.37 | 675.22 | +341.85 | 384.12 | 719.06 |
| JS: required fonts wait | 26.03 | 141.44 | +115.41 | 27.73 | 148.78 |
| JS: SQLite initial launch gate | 3.24 | 112.50 | +109.26 | 3.47 | 125.61 |
| JS: initial authentication | 16.37 | 15.81 | -0.56 | 18.57 | 18.51 |
| JS: splash hide promise | 67.23 | 63.45 | -3.78 | 69.88 | 67.01 |
| JS: splash resolved → useful Home | 172.81 | 300.21 | +127.40 | 228.40 | 354.10 |
| JS: collector → root module ready | 22.01 | 20.21 | -1.80 | 26.73 | 23.38 |
| JS: root module → root commit | 8.20 | 8.97 | +0.78 | 9.20 | 10.33 |
| RN: startup start → end | 36.78 | 31.03 | -5.75 | 37.77 | 33.62 |

The sequential candidate group was slower inside measured JS spans, so the host increase cannot be dismissed as polling alone. Mean additional waits concentrate in fonts (+116.32 ms), SQLite readiness (+111.29 ms), and splash resolution to useful Home (+114.12 ms). Authentication and root initialization show no corresponding increase. These spans include native dispatch and JS callback scheduling; they do not establish font-decoding or SQL CPU cost. Startup source is byte-identical between captured checkouts except the clock description. No gates were moved.

RN's bundle-entry and runtime-start markers are almost coincident in these artifacts, with the bundle marker about 0.003–0.004 ms earlier. They do not isolate separate runtime-versus-bundle work. Native allocation/frame attribution remains necessary.

### Baseline individual launches (ms)

| Trial | Host export | JS collector → Home | Fonts | SQLite gate | Auth | Splash promise | Splash → Home | RN startup |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 3041.99 | 318.86 | 21.67 | 3.11 | 15.95 | 67.26 | 171.81 | 36.67 |
| 2 | 3110.52 | 371.70 | 22.57 | 3.43 | 16.21 | 67.11 | 220.98 | 36.37 |
| 3 | 3056.74 | 374.23 | 25.63 | 3.42 | 16.38 | 66.58 | 224.94 | 37.14 |
| 4 | 3057.94 | 369.84 | 25.70 | 3.10 | 16.59 | 66.47 | 220.49 | 37.13 |
| 5 | 3055.14 | 384.12 | 26.03 | 3.24 | 18.57 | 68.83 | 228.40 | 36.51 |
| 6 | 3046.46 | 323.27 | 26.54 | 3.31 | 16.37 | 67.43 | 171.82 | 37.15 |
| 7 | 3057.37 | 323.27 | 27.30 | 3.23 | 16.33 | 67.02 | 171.56 | 37.67 |
| 8 | 3042.51 | 326.68 | 26.71 | 3.19 | 15.79 | 69.88 | 172.64 | 36.78 |
| 9 | 3032.71 | 377.75 | 27.04 | 3.47 | 16.82 | 67.51 | 224.18 | 37.77 |
| 10 | 3041.22 | 333.37 | 27.73 | 3.44 | 17.39 | 67.23 | 172.81 | 36.76 |

### Candidate individual launches (ms)

| Trial | Host export | JS collector → Home | Fonts | SQLite gate | Auth | Splash promise | Splash → Home | RN startup |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 3678.89 | 718.80 | 139.86 | 111.10 | 15.48 | 63.26 | 354.10 | 30.34 |
| 2 | 3784.03 | 681.24 | 148.78 | 125.61 | 15.93 | 65.65 | 286.79 | 33.62 |
| 3 | 3658.19 | 668.82 | 141.74 | 111.67 | 15.81 | 63.42 | 301.28 | 31.45 |
| 4 | 3673.01 | 667.74 | 140.02 | 116.63 | 17.99 | 65.36 | 293.06 | 30.74 |
| 5 | 3645.58 | 670.32 | 141.44 | 112.17 | 16.02 | 63.45 | 300.21 | 31.03 |
| 6 | 3679.24 | 675.22 | 139.32 | 112.74 | 15.32 | 67.01 | 305.76 | 31.30 |
| 7 | 3643.25 | 719.06 | 141.99 | 113.43 | 15.75 | 63.04 | 344.80 | 31.44 |
| 8 | 3648.95 | 662.44 | 140.58 | 112.04 | 15.58 | 64.42 | 294.73 | 31.11 |
| 9 | 3543.66 | 677.98 | 143.66 | 117.98 | 18.51 | 66.60 | 296.05 | 30.03 |
| 10 | 3662.03 | 712.32 | 142.73 | 112.50 | 15.82 | 62.86 | 344.09 | 30.53 |

### Reinstalled-build controls (A1/B1/A2/B2)

A1/B1 are the original baseline/candidate groups; A2/B2 repeat the same respective executable and embedded bundle after the twenty-cycle browsing runs. Each group contains ten process-cold launches. The control identities match their originals before and after capture; app data, keychain, and caches remain preserved.

All values below are milliseconds; p50 and p95 use nearest rank. Combined intervals are calculated within each individual trial before deriving distributions.

| Measurement | A1 p50 | B1 p50 | A2 p50 | B2 p50 | B2 − A2 | B2 p95 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Host: local export observed | 3046.46 | 3658.19 | 3345.98 | 3634.63 | +288.65 | 3660.81 |
| JS: collector → useful Home | 333.37 | 675.22 | 670.22 | 664.41 | -5.81 | 705.87 |
| JS: required fonts wait | 26.03 | 141.44 | 136.49 | 140.09 | +3.60 | 150.52 |
| JS: fonts ready → SQLite onInit starts | 2.68 | 0.03 | 40.19 | 0.03 | -40.17 | 0.03 |
| JS: SQLite onInit → launch gate | 3.24 | 112.50 | 73.28 | 112.76 | +39.48 | 133.04 |
| JS: fonts ready → SQLite launch gate | 5.93 | 112.53 | 113.66 | 112.78 | -0.88 | 133.07 |
| JS: fonts start → SQLite launch gate | 32.48 | 253.64 | 250.15 | 252.47 | +2.32 | 283.59 |
| JS: initial authentication | 16.37 | 15.81 | 14.99 | 15.23 | +0.24 | 18.07 |
| JS: splash hide promise | 67.23 | 63.45 | 64.63 | 63.10 | -1.53 | 65.90 |
| JS: splash resolved → useful Home | 172.81 | 300.21 | 301.15 | 298.53 | -2.63 | 340.77 |
| RN: startup start → end | 36.78 | 31.03 | 34.40 | 30.99 | -3.41 | 35.47 |

### A2 individual launches

| Trial | Host export | JS collector → Home | Fonts | SQLite gate | Auth | Splash promise | Splash → Home | RN startup |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 3350.35 | 677.86 | 142.74 | 74.09 | 16.17 | 66.62 | 304.18 | 34.40 |
| 2 | 3352.13 | 708.88 | 139.27 | 101.97 | 15.76 | 68.18 | 299.92 | 34.49 |
| 3 | 3310.49 | 714.72 | 137.86 | 36.01 | 14.66 | 63.74 | 350.67 | 40.25 |
| 4 | 3345.98 | 654.75 | 135.30 | 73.24 | 14.99 | 64.63 | 293.68 | 34.15 |
| 5 | 3350.23 | 663.87 | 136.49 | 73.47 | 15.07 | 63.17 | 301.15 | 34.23 |
| 6 | 3337.58 | 652.97 | 136.82 | 72.79 | 14.07 | 65.06 | 290.31 | 35.25 |
| 7 | 3364.18 | 662.79 | 136.08 | 74.44 | 14.89 | 64.79 | 298.70 | 37.02 |
| 8 | 3297.88 | 716.86 | 135.82 | 73.28 | 15.60 | 63.19 | 356.23 | 34.03 |
| 9 | 3337.82 | 670.22 | 137.04 | 74.22 | 14.76 | 64.25 | 306.72 | 34.94 |
| 10 | 3350.30 | 672.12 | 135.48 | 73.18 | 15.24 | 71.34 | 304.13 | 34.16 |

### B2 individual launches

| Trial | Host export | JS collector → Home | Fonts | Fonts ready → SQLite start | SQLite onInit | Combined fonts ready → gate | Post-splash → Home | RN startup |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 3557.57 | 661.58 | 140.54 | 0.03 | 112.39 | 112.42 | 294.89 | 35.17 |
| 2 | 3659.70 | 686.65 | 150.52 | 0.03 | 133.04 | 133.07 | 290.86 | 32.68 |
| 3 | 3522.70 | 705.87 | 139.25 | 0.03 | 113.20 | 113.23 | 339.30 | 29.88 |
| 4 | 3554.88 | 659.95 | 140.09 | 0.03 | 112.86 | 112.88 | 291.91 | 35.47 |
| 5 | 3637.64 | 661.82 | 140.96 | 0.03 | 111.29 | 111.32 | 299.26 | 29.91 |
| 6 | 3634.63 | 673.59 | 141.58 | 0.02 | 113.59 | 113.62 | 303.49 | 29.44 |
| 7 | 3660.81 | 705.04 | 138.65 | 0.03 | 112.76 | 112.78 | 340.77 | 29.78 |
| 8 | 3649.75 | 664.41 | 139.64 | 0.02 | 110.59 | 110.61 | 302.79 | 31.57 |
| 9 | 3536.77 | 666.33 | 140.38 | 0.03 | 112.90 | 112.93 | 298.53 | 30.99 |
| 10 | 3652.04 | 657.27 | 139.38 | 0.03 | 110.92 | 110.94 | 294.35 | 32.01 |

### Control interpretation

Restoring the original baseline did not restore the original short font wait or first useful Home interval. In A2, some SQLite-related delay moves from onInit into the uninstrumented opening/dispatch interval before onInit: compare the combined fonts-ready-to-SQLite-gate interval rather than the onInit duration alone.

The A/B/A/B results separate a repeatable difference associated with a build from drift that also affects restored baseline launches. They do not isolate the effect of Discover or feedback changes: preserved local data/cache state, host scheduling, native dispatch, and startup/export work outside measured spans remain uncontrolled. Smaller residual differences require interleaved replication and native attribution; no claim that the optimizations caused the delay, eliminated all delay, or improved displayed launch time follows from this run.

Ordered samples and distributions for all four groups, plus B2−A2 and B2−B1 changes, are retained in startup-comparison.json.

### Observed residual

The B2−A2 host export p50 difference remains **+288.65 ms**, while the JS collector-to-Home p50 difference is **-5.81 ms**. All forty launches reached useful Home content. The remaining host-export difference is observed but not attributed: pre-collector launch work, deferred export scheduling/native file I/O, and host launch/container lookup/polling have no separate stamps.

The control does not establish a user-visible startup regression or a startup speedup. It also does not erase the original slower measurements: it shows that nearly the same JS delays recur on the restored baseline and that further controlled native/host attribution is needed for the residual.





## Memory

Twenty browse/background cycles use one Release process per build. Each cycle browses three swipes, backgrounds into Settings, resumes Home, settles for three seconds, and samples physical footprint. Image-cache filenames supply completed render keys and frame/color signatures; they do not identify retained objects or exact distinct climb UUIDs.

The original baseline process (PID 59831) rose from 256.8 to 291.9 MiB; the candidate process (PID 9536) rose from 252.9 to 284.0 MiB. Across the twenty settled observations, baseline p50/p95/max were 291.4/292.3/293.4 MiB; candidate values were 279.7/284.1/284.2 MiB.

| Cycle | Baseline MiB | Candidate MiB | Baseline completed render keys | Candidate completed render keys |
| ---: | ---: | ---: | ---: | ---: |
| 1 | 256.8 | 252.9 | not sampled | 385 |
| 2 | 265.8 | 258.2 | not sampled | 385 |
| 3 | 269.8 | 266.0 | not sampled | 385 |
| 4 | 272.2 | 266.5 | not sampled | 385 |
| 5 | 279.6 | 271.0 | not sampled | 385 |
| 6 | 280.5 | 270.9 | 146 | 385 |
| 7 | 278.8 | 271.5 | 146 | 385 |
| 8 | 278.7 | 280.2 | 163 | 385 |
| 9 | 279.0 | 280.4 | 181 | 385 |
| 10 | 292.1 | 281.8 | 199 | 385 |
| 11 | 292.1 | 279.5 | 216 | 385 |
| 12 | 292.3 | 279.7 | 234 | 385 |
| 13 | 291.4 | 279.7 | 251 | 385 |
| 14 | 291.7 | 279.7 | 269 | 385 |
| 15 | 291.9 | 280.0 | 286 | 385 |
| 16 | 291.8 | 284.0 | 304 | 385 |
| 17 | 293.4 | 284.0 | 321 | 385 |
| 18 | 291.9 | 284.1 | 338 | 385 |
| 19 | 291.9 | 284.2 | 356 | 385 |
| 20 | 291.9 | 284.0 | 373 | 385 |

These are sequential browsing samples, not independent trials or a memory budget. The candidate reused **385 existing render-cache entries throughout**. The baseline sidecar began only after cycle six and saw growth from 146 to 373 entries. Earlier baseline key counts were not sampled. This cache-state difference prevents attributing the smaller candidate footprint to the app changes. Both runs preserved the same cache policy; neither proves that growth is unbounded or that a leak was fixed.

Allocation inspection ran separately from the comparison. The simulator Allocations recorder did not complete and was stopped by its recorded PID. Its trace is invalid. There is no established retained-object defect and no basis here for a memory-leak claim or a cache-policy change. Allocation attribution, exact distinct-climb counts during Release browsing, and native frame/energy measurements remain device-validation work.

## Verification and remaining device work

Mobile typechecking, all 862 mobile test suites / 9,351 tests, iOS/Android bundle checks, and repository typechecking passed. Repository lint/format passed with existing warnings. A pre-existing Bluetooth test mock omitted `consumeBackgroundAdoptSendGate`; the same 17 failures reproduced on baseline. Adding its existing false-return default fixed the test setup without changing production BLE. Astra independently approved that test-only repair.

Native QA confirmed that a programmatic scroll-to-end leaves 20 items loaded, one subsequent real gesture loads exactly 40, and settling does not drain further pages. A recycled card named “Performance owned 180” opened `/discover/ios-performance-v1-owned-180`. Appending kept the scroller in the same portion of the shelf: the first mounted item was “Performance owned 180”, rather than returning to item 200. This is a qualitative position check, not a pixel-offset measurement. The real drawer sequence opened feedback, preserved “Local performance QA draft” through ordinary dismissal/reopening, then stayed closed after drag dismissal and Home navigation. Submission freshness, failed uploads, attachment reuse, consent, authentication/pin changes, smart-pin hydration, duplicate pages, failed pages, and exhausted streams have automated coverage.

Maximum native text-size QA exposed vertical glyph clipping in owned-card labels and shared text, including the unchanged pinned grid, smart shelf, and section headings. The new shelf allocates scaled height, but this run is not an accessibility pass for the existing text system. Text size was restored to `large` before Release measurement. Phone text-layout validation remains explicit follow-up work.

The required simulator smoke and screenshot checks passed against the verified candidate Release export. The tooling has 152 focused tests and is included in the normal scripts typecheck. Three independently reviewed PRs separate [tooling #5327](https://github.com/boardsesh/boardsesh/pull/5327), [feedback/startup #5328](https://github.com/boardsesh/boardsesh/pull/5328), and [Discover #5329](https://github.com/boardsesh/boardsesh/pull/5329).

Raw artifacts are retained locally under `.boardsesh/performance-follow-up-2026-09-08/`: source manifests and patches, executable UUIDs and hashes, embedded bundle hashes, individual measurements, screenshots, React change descriptions, native samples, completed capture verdicts, and rejected attempts. They are intentionally not committed. [The profiling guide](ios-profiling.md) documents repeat runs.
