# iOS simulator performance audit — 8 September 2026

## Findings at a glance

**Start with Discover's playlist-card callbacks.** React profiling recorded 120 card renders where the only changed props were `onPress` and `onTogglePin`. The cards are already memoized, but those new function identities defeat the memoization, including with React Compiler enabled.

The source-built Release app successfully loaded Home, browsed climbs, opened the play drawer, and advanced through climbs. Three process-cold launches displayed populated Home content by approximately **2.47 seconds**. Physical footprint was **195.7 MiB on Home**, **262.9 MiB during climb browsing**, and **273.7 MiB after twelve carousel swipes**. These are simulator observations, not device performance budgets.

| Priority | Improvement | Evidence | Confidence |
| --- | --- | --- | --- |
| 1 | Give playlist cards stable action props | 120 measured renders changed only two callback props | High for unnecessary renders; production savings unmeasured |
| 2 | Virtualize or cap Discover's growing shelves | Paginated arrays are appended and mapped into `ScrollView` children | High for scaling behavior; large-library impact unmeasured |
| 3 | Stop closed feedback sheets subscribing to every navigation/queue update | Eight sheet renders; hook reads pathname and full queue context | High for subscriptions; modest measured cost |
| 4 | Add startup phase measurements before optimizing launch | Populated Home first observed at 2.468–2.475 s | High for observation; bottleneck not attributed |
| 5 | Provide a repeatable simulator profiling setup | Watcher failure, wrong advertised Metro URL, profiler incompatibility, shared simulator interference | Reproduced |

No application changes are included in this audit. The temporary Metro watcher override was restored.

## What ran

| Item | Configuration |
| --- | --- |
| Source checkout | `38bf41c0f95d4e514fe5e68142688fc8ecbc98af` on `main` |
| Host | Apple M5 Max, 128 GiB RAM, macOS 26.6.2 |
| Xcode | 26.6, build 17F113 |
| Simulator | iPhone 17 Pro model, iOS 26.5; named **Boardsesh Performance Audit** |
| Simulator identifier | `561A4D7D-12C6-4B27-A956-A69C4436F4BE` |
| App | Expo 57 / React Native 0.86.3 / Hermes; React Compiler enabled |
| Builds | Debug and Release, compiled using `vp run mobile:ios` |
| Backend | This checkout's local development backend on port 8197; seeded test account |
| JS delivery | Debug: localhost Metro port 8097. Release: embedded `main.jsbundle`, approximately 18 MiB |
| Test mode | Screenshot mode: automatic local test login, Aura rendering, simulated wall seed |
| Board | Tension at 40°; initial visible climb **Masquerade** |

Both native builds reported success: Debug had zero errors and 12 warnings; Release had zero errors and 22 warnings. Dependencies were restored with `vp install`, without a tracked lockfile change.

The generated iOS project already present in this checkout reports native version **2.3.1 (1)**, while `app.config.ts` specifies 2.5.0. The audit compiled the existing native project and current application source; it did not regenerate the project. Treat this as a local source-build audit, not a reproduction of the current App Store binary or native fingerprint.

Screenshot mode bypasses onboarding and seeds six simulated wall climbs. The default named-board selector did not match the local fixtures and used its fallback. There was no physical Bluetooth board, production account, or large personal logbook in this run.

## Measured navigation work

The Debug run navigated Home → Climbs → Discover → Profile twice. Each scenario lasted approximately six seconds. Measurement used React DevTools' renderer profiling interface, `PerformanceObserver` long tasks, and a bounded `requestAnimationFrame` callback. Four tabs had already been visited in preliminary runs, so these are **warm navigation measurements**, not first-mount benchmarks.

| Destination | JS long task, visit 1 / 2 | Largest JS frame-callback gap, visit 1 / 2 |
| --- | --- | --- |
| Home | 73.2 / 74.2 ms | 81.8 / 83.8 ms |
| Climbs | 76.2 / 76.1 ms | 85.4 / 84.9 ms |
| Discover | 105.6 / 108.5 ms | 115.1 / 118.6 ms |
| Profile / You | 73.5 / 73.0 ms | 81.9 / 81.2 ms |

Each scenario had one observed long task. The 95th-percentile JS callback gap was 16.76–16.87 ms. That does **not** establish native UI FPS or the number of visibly dropped frames: JS callback cadence and displayed-frame timing are different measurements.

Across the recorded React profile:

- 44 commits; the largest recorded render duration was **27.382 ms**.
- Four commits had render duration above 16.67 ms.
- `PlaylistCard` rendered **120 times**. All 120 change descriptions listed only `onPress` and `onTogglePin` as changed props, with no changed context or hooks.
- In the largest commit, Discover's subtree accounted for **11.59 ms** of inclusive render time.
- `FeedbackSheet` rendered eight times, totaling **6.23 ms self render time**. Its inclusive cost in the largest commit was **1.293 ms**.

Inclusive subtree durations overlap; they must not be added together. React render durations also do not cover the whole long task, native layout, or GPU work. Stabilizing the card callbacks will not necessarily remove the entire 106–108 ms Discover task.

An earlier first Climbs visit produced a 515.2 ms long task, followed by 74.9 ms. It was not replicated as a controlled first-mount test and is a lead for startup investigation, not a production latency claim.

### 1. Stabilize Discover's card callbacks

The source matches the profile: [Discover](../packages/mobile/app/(tabs)/discover/index.tsx) creates per-card closures in its pinned grid, owned-playlist shelf, smart playlists, and community shelf. For example, lines 526–537 map playlists into cards with `onPress={() => goToPlaylist(playlist.uuid)}` and `onTogglePin={() => handleToggleCardPin(playlist)}`. [PlaylistCard](../packages/mobile/src/components/playlist/PlaylistCard.tsx) is wrapped in `memo`, but receives new functions on parent renders.

Introduce a memoized item component that accepts an item identifier and stable parent actions, binding its callbacks internally with `useCallback`. Apply the same pattern to smart cards and pin actions. Preserve current navigation and pin semantics; avoid a custom comparator that ignores callbacks and risks stale actions.

**Verify:** Repeat the same tab sequence with React change descriptions enabled. Cards whose content and pin state did not change should not render just because their parent handled focus. Compare total Discover render time and long tasks before and after, then verify on a Release build on a phone.

### 2. Bound the cost of growing Discover shelves

[HorizontalScrollSection](../packages/mobile/src/components/HorizontalScrollSection.tsx) uses a horizontal `ScrollView`. Discover passes every loaded owned/community playlist through `.map()` into that view. [useUserPlaylists](../packages/shared/playlists-react/src/use-user-playlists.ts) appends pages of 20; [useDiscoverPlaylists](../packages/shared/playlists-react/src/use-discover-playlists.ts) appends popular/recent pages. Neither hook imposes a total retained-page ceiling.

The component comment says the shelf's loaded count is bounded, but pagination bounds each request, not the accumulated mounted children. A climber who continues swiping mounts progressively more cards. This compounds finding 1. The fixed eight-card pinned section is already capped and does not have the same scaling problem.

Use a horizontal virtualized list for growable shelves, or cap each preview shelf and send further browsing to the existing “See all” route. Keep one-page-at-a-time fetching; the hooks already have request guards, so this is not evidence of a fetch-drain loop.

**Verify:** Use a local fixture with at least 200 playlists. Check that mounted card count stays near the visible window, pagination fetches once per boundary, and returning to a shelf preserves the expected position. This run did not measure a 200-playlist account.

### 3. Keep closed feedback sheets out of navigation updates

[FeedbackSheet](../packages/mobile/src/components/user-drawer/FeedbackSheet.tsx) calls [useSubmitMobileAppFeedback](../packages/mobile/src/lib/feedback/use-submit-app-feedback.ts), which subscribes to `usePathname()` and the full `useQueue()` context. A sheet that was never opened during the tab test still rendered eight times. The queue subscription also exposes it to updates beyond the current climb metadata the eventual submission needs.

Mount the feedback form when requested, or move metadata subscriptions into an active form and read the necessary current state at submission. Preserve the latest route/board/session in submitted reports. This is a smaller optimization than the playlist callbacks: the measured self cost was only 6.23 ms across the whole run.

## Release checks

### Launch readiness

Three trials terminated only the app process, launched the embedded Release build, and repeatedly captured screenshots. Local Vision OCR required both “Recent sessions” and a loaded session's identifying text. The timer began immediately before `simctl launch`; it includes command overhead. Disk caches, login state, and the local backend were warm.

| Trial | Last screenshot without the required content | First screenshot with populated Home |
| --- | --- | --- |
| 1 | 2.030 s | 2.474 s |
| 2 | 2.030 s | 2.468 s |
| 3 | 2.056 s | 2.475 s |

These are observation windows, not exact time-to-first-frame measurements. Screenshot/OCR polling perturbs the run, and three trials do not establish a percentile distribution.

**Next improvement:** Add separate startup spans for native launch, JS initialization, SQLite initialization, auth readiness, font readiness, and first useful Home content. [RootLayout](../packages/mobile/app/_layout.tsx) hides the splash when auth and fonts are ready; [DatabaseProvider](../packages/mobile/src/providers/database-provider.tsx) also sits above auth initialization. This run does not establish which phase dominates. Measure those phases before moving gates or deferring work.

### Browsing and memory

Physical footprint comes from macOS `sample` reports for the same Release process, PID 77543. These figures are not `ps` RSS and should not be compared directly with RSS values in the Debug artifacts.

| Point in the Release run | Physical footprint | Process peak at that point |
| --- | --- | --- |
| Settled Home | 195.7 MiB | 196.5 MiB |
| During twelve climb-list swipes | 262.9 MiB | 264.0 MiB |
| Play drawer open after browsing | 263.6 MiB | 294.3 MiB |
| After twelve carousel swipes | 273.7 MiB | 294.3 MiB |
| Briefly backgrounded into Settings | 268.7 MiB | 294.3 MiB |

The list visibly advanced to different climbs with thumbnails present. The carousel advanced from **Masquerade** to **Doomscroll**, with hold overlays visible. The twelve carousel swipes added approximately **10.1 MiB** over the preceding settled drawer snapshot. This short run does not demonstrate unbounded growth or a memory leak.

Backgrounding reduced physical footprint by about 5 MiB in the short sample. That is not proof that cache cleanup failed: physical footprint cannot identify object ownership or allocator retention. Follow up with a longer repeated browse/background cycle and allocations/retained-object inspection on a constrained phone before changing cache policy.

Native stack sampling during Release scrolling showed substantial waiting between work, with active samples in Hermes and Yoga layout. It did not establish a sustained CPU-bound loop or a dominant board-rasterization hotspot. Automation and sampling overhead are present; this is not a frame-rate pass.

Existing protections worth retaining are the virtualized climb list, indexed ascent lookups, scheduled board renders, display-sized overlays, and the 256 MiB image-cache ceiling documented in [the performance playbook](react-native-performance.md). This audit provides no basis to replace them or increase that ceiling.

## Profiling setup improvements and limitations

1. **Make Watchman opt-in explicit for large macOS checkouts.** Metro repeatedly failed with `EMFILE` even after raising the shell file limit. The installed Expo Metro configuration sets `resolver.useWatchman` to `null`, while Expo's file-map fork resolves that to `false`. Temporarily setting it to `true` allowed startup. Prefer a documented local profiling option with a Watchman availability check; the audit's tracked config change was removed.
2. **Make `--host localhost` consistent with advertised URLs.** `mobile-dev-start.ts` still derives `REACT_NATIVE_PACKAGER_HOSTNAME` from Tailscale. With localhost-only binding, the manifest advertised an unreachable Tailscale bundle URL. `TAILSCALE_HOSTNAME=localhost` plus `--host localhost` fixed it. Metro remained bound to loopback.
3. **Avoid the wrapper's implicit Metro selection.** `vp run mobile:ios -- --no-bundler` built successfully but attempted to open port 8081, occupied by another checkout. Expo rejects combining `--port` with `--no-bundler`. Document a build/install-only path followed by an explicit dev-client URL, and launch Release through the app identifier.
4. **Provide a supported profiling binary and enforce simulator ownership.** Hermes rejected `Tracing.start` because multiple React Native hosts were registered in the development client. `Profiler.enable` was unsupported. Instruments Time Profiler did not produce a completed usable capture, so no flame-graph or native FPS claim is made. React commit profiling and native `sample` were usable alternatives.

Another active checkout replaced the dedicated simulator's native app during the Debug portion, changing its native version to 2.5.0; its launcher later selected port 8095. The saved navigation profile was captured from this checkout's port-8097 JavaScript, but its native host had been replaced. Therefore its callback-change evidence is useful, while its absolute timing and memory numbers are provisional. A Debug scrolling capture interrupted by this interference was excluded. The subsequent Release install restored this audit's source-built binary and provided the Release measurements above.

The host also ran other development processes, and Release compilation overlapped the Debug navigation run. There is no controlled idle-host A/B comparison, physical-device FPS trace, large-logbook test, BLE test, energy measurement, or production-network benchmark here. React Native's [profiling guidance](https://reactnative.dev/docs/profiling) recommends profiling with development mode off; the Debug measurements are attribution evidence, not a production performance verdict.

## Evidence and reproduction

Raw evidence remains in the repo's ignored local directory `.boardsesh/performance-2026-09-08/`:

- `summary.json`, `navigation.json`, `navigation-react.json`, and `navigation-names.json`: bounded navigation observations, React durations, changed props, and component names.
- `release-launch.json` and `release-launch-1.png` through `release-launch-3.png`: launch observation windows and confirming screenshots.
- `release-home.sample.txt`, `release-scroll.sample.txt`, `release-board.sample.txt`, `release-carousel.sample.txt`, and `release-background.sample.txt`: Release native stacks and footprint headers.
- `release-home.png`, `release-climbs.png`, `release-climbs-scrolled.png`, `release-board.png`, and `release-carousel.png`: verified Release surfaces.
- `reproduction/`: the CDP/React measurement scripts, summary script, launch/OCR scripts, and Maestro swipe flows. These are session helpers with local paths and process/module IDs; resolve fresh IDs before reuse.
- Build and Metro logs. Incomplete `.trace` output and the interrupted Debug scroll artifacts are retained for diagnosis, not used as successful measurements.

For a repeat run, start the local seeded backend, reserve a simulator explicitly, and record the source SHA plus native executable identity. Use the repository build wrapper for Debug and Release. For Debug, use a free localhost Metro port with `TAILSCALE_HOSTNAME=localhost`; check the manifest's bundle URL before launch. For Release, verify the embedded bundle and launch `com.boardsesh.app` directly. Keep screenshot-mode behavior identical between trials. Stop native builds and avoid simultaneous simulator automation while recording the comparison.

The Markdown contains the findings and quantitative summaries needed for review; raw local artifacts are not committed to Git.
