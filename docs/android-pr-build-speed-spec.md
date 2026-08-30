# Android PR build: stop paying for a cold Gradle cache on every PR

Status: proposal for review · Surface: CI only (`.github/workflows/android-pr-rn.yml`;
fix 3 also touches `ios-rn-ci.yml`) · No change to release/dev-client builds.
All numbers from `gh run list` / `gh run view` / `gh cache list` on 2026-07-03. Every
load-bearing number is reproduced inline; the cited run ids are provenance (their logs
expire after ~90 days, the tables here don't).

## TL;DR

`Android PR Build (React Native) / prebuild-and-build` is the merge-blocking tail on
essentially every mobile PR: **~21 min typical, ~15 min best case**, vs ~7.5 min for the
next-longest check (CI). It can't start any earlier — it already starts at t=0 with every
other workflow (single job, no `needs:`, runner pickup ~20 s). The duration is the
problem, and most of it is avoidable with three config-only changes:

1. **Restore-only Gradle cache, warmed by `main`.** Today every PR run saves its own
   3.4 GB cache under a PR-only key prefix. Those saves blow the repo's 10 GB cache
   budget, evict each other _and_ `main`'s caches, and a new PR can never inherit a warm
   cache — so cold builds are the norm. Meanwhile `main` already builds a perfectly good
   cache on every mobile merge; PR runs just can't reach it.
2. **Robolectric tests in a parallel job.** They currently run serially before the APK
   build in the same job, adding their full 2.5–7.5 min to the critical path for no
   ordering reason.

3. **Skip the native build entirely on JS-only PRs** (maintainer decision, from review):
   `main` already skips the native release build for JS-only merges via the fingerprint
   gate in `android-apk-rn.yml`; PRs should behave the same. A gate job compares the
   PR's Expo fingerprint against its merge-base and skips both jobs when they match.

Expected result: JS-only mobile PRs (the majority) stop paying for the native build at
all — the PR tail becomes CI's ~7.5 min. Native-input PRs go from ~21 min typical to
**~14–15 min** (warm cache + ~2 min gate). Free runners, one-revert rollback.

## The problem

For one sampled mobile PR commit (`e5f07c5`, PR #3436), every PR workflow was created at
the same second (23:27:48Z) and finished:

| Workflow                 | Duration                                         |
| ------------------------ | ------------------------------------------------ |
| Mobile OTA Compatibility | 1m 23s                                           |
| iOS CI (React Native)    | 4m 31s                                           |
| Mobile OTA Preview       | 5m 53s                                           |
| CI                       | 7m 23s                                           |
| **Android PR Build**     | **15m 12s** (a _warm-cache_ run — its best case) |

Across the last 15 successful runs: **11 took 20–23 min, 4 took 14–15 min**, median
≈ 21 min. So the Android build is what we wait for after the last push to a mobile PR,
usually by ~3× over the next check. `cancel-in-progress: true` (correct, keep it) means
every push restarts that 21-min clock.

## How it works today (verified)

- **It already starts as early as possible.** The workflow triggers directly on
  `pull_request`, has a single job with no `needs:` and no change-detection gate. On the
  sampled commit, `createdAt == startedAt` and the runner picked the job up 20 s later.
  "Start it earlier" is not an available lever; only the duration is.
- **A cache miss costs ~7.5 min.** Step timing, warm (run `28687742590`, 15m12s) vs cold
  (run `28687558115`, 22m46s):

  | Step                            | Warm               | Cold               |
  | ------------------------------- | ------------------ | ------------------ |
  | checkout → SDK setup → prebuild | ~1m 30s            | ~1m 00s            |
  | Gradle cache restore            | 31s                | 0s (nothing found) |
  | Robolectric module tests        | 2m 35s             | 7m 32s             |
  | `assembleRelease` (arm64-only)  | 10m 43s            | 13m 03s            |
  | cache save (post step)          | ~1s (hit, skipped) | 40s                |

  The delta is dependency downloads, the Gradle distribution, and artifact transforms,
  paid inside both Gradle steps.

- **The PR cache key prefix can never exist on `main`.** The job caches
  `~/.gradle/caches` + `~/.gradle/wrapper` under
  `${{ runner.os }}-gradle-rn-pr-${{ hashFiles('packages/mobile/package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml') }}`,
  a prefix deliberately separate from the release workflow's `gradle-rn-`. But the
  workflow only runs on `pull_request`, and GitHub lets a PR run restore caches only from
  its own merge ref or from the default branch. No `-pr-` cache on `main` → the first
  build of every PR is fully cold.
- **Every PR run saves 3.4 GB, and that's what evicts everything.** The repo cache
  budget is 10 GB. Snapshot from 2026-07-03: two `Linux-gradle-rn-pr-<hash>` caches at
  3.43 GB each (refs `pull/3440`, `pull/3436`) plus ~3 GB of vite-plus / buildkit / pods
  caches — at the limit, and **no `gradle-rn-*` cache left on `main` at all** (the
  release and dev-client caches had been LRU-evicted). This also breaks the one case the
  per-PR cache was meant to help: a PR's second push often finds its own cache already
  evicted by a sibling PR's save.
- **`main` already produces the cache we need, continuously.** `android-apk-rn.yml`
  (release, key `gradle-rn-<hash>`) and `android-apk-dev-client.yml` (dev client, key
  `gradle-rn-dev-<hash>`) run on every mobile-touching push to `main` with the same path
  filters as this workflow. The warm cache exists right after any mobile merge; PR runs
  just can't reach it, and their own saves push it out.

## Fix 1: restore-only PR cache, keyed to `main`'s release cache

Replace `actions/cache@v4` with `actions/cache/restore@v4` and adopt the release key:

```yaml
- name: Restore Gradle cache (read-only, warmed by android-apk-rn.yml on main)
  uses: actions/cache/restore@v4
  with:
    path: |
      ~/.gradle/caches
      ~/.gradle/wrapper
    key: ${{ runner.os }}-gradle-rn-${{ hashFiles('packages/mobile/package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml') }}
    restore-keys: |
      ${{ runner.os }}-gradle-rn-
```

- **Every PR run — first push included — restores the cache `main` last built.** Exact
  hit when `pnpm-lock.yaml` / `pnpm-workspace.yaml` / `packages/mobile/package.json` match `main`; prefix fallback
  otherwise (Gradle re-downloads only the delta). The prefix also matches the dev-client
  cache (`gradle-rn-dev-<hash>`) — whichever `main` cache was written most recently wins
  a prefix match, and that's fine: Gradle's dependency cache is additive-only (entries
  are keyed by module coordinates + checksums; wrong or extra entries are ignored, never
  mis-built from), both builds resolve the same monorepo dependency graph, and the dev
  client merely adds the `expo-dev-client` modules. A dev-cache hit is marginally less
  complete than a release hit, never incorrect. Narrowing the prefix to exclude `-dev-`
  isn't possible (restore-keys are prefix-only) and re-keying the release workflow to
  allow it isn't worth the churn.
- **PR runs stop saving.** The repo drops back under the 10 GB budget, so `main`'s caches
  stop being evicted — that persistence is what makes the restore reliable. The 40 s
  post-step save disappears from PR runs too.
- **Every PR restore refreshes the release cache's LRU timestamp**, protecting it from
  eviction by unrelated cache churn.

**Why the key separation stops mattering.** The current comment in the workflow says the
prefixes are separate "so a debug-signed cache never masks a release-build regression
(and vice versa)". Both directions are covered:

- _PR (debug-signed) cache masking a release regression:_ impossible after this change —
  PR runs never write a cache, so nothing debug-signed is ever stored. (It was already
  impossible before, for a different reason: caches created on a PR ref are invisible to
  `main` runs.)
- _Release cache masking a PR regression:_ `~/.gradle/caches` + `~/.gradle/wrapper` hold
  dependency jars, artifact transforms, and the Gradle distribution — no task outputs, no
  signing state (`org.gradle.caching` is not enabled in this project). Restoring them
  can't change what the PR build compiles or verifies, only how fast dependencies
  resolve.

The release and dev-client workflows are untouched: same keys, same save behaviour.

**Residual risk:** if `main`'s cache is evicted anyway — budget-pressure LRU during a
stretch without mobile merges, or GitHub's 7-day unused-cache TTL (restores refresh it,
but with fix 3 only native-input PRs restore, so eviction takes 7+ days without a
native-input PR or a mobile merge) — PR builds degrade
to today's cold behaviour, no worse. The next mobile merge (or a manual
`workflow_dispatch` of `android-apk-rn.yml`) repopulates it.

## Fix 2: run the Robolectric tests in a parallel job

The test step and `assembleRelease` are independent Gradle invocations — the tests
compile the debug variant of the live-activity module, the APK build compiles release.
Nothing is shared but the setup. Splitting them into two jobs with no `needs:` between
them takes the tests off the critical path entirely:

```yaml
jobs:
  robolectric-tests: # ~5 min wall, off the critical path
    runs-on: ubuntu-latest
    # 20 min ≈ 2.5× the observed cold-cache duration (7m32s): kills a hung
    # Gradle daemon reasonably fast without flaking on a slow runner.
    timeout-minutes: 20
    steps:
      - uses: actions/checkout@v4
      - uses: ./.github/actions/android-rn-setup
      - name: Run live-activity module unit tests (Robolectric)
        # existing step, moved verbatim (incl. the project-discovery logic)

  build-apk: # critical path: ~12.5 min warm
    runs-on: ubuntu-latest
    timeout-minutes: 45
    steps:
      - uses: actions/checkout@v4
      - uses: ./.github/actions/android-rn-setup
      - name: Build debug-signed release APK
        # existing step, unchanged
      - name: Upload sideloadable APK
        # existing step, unchanged (if: always())
```

The shared setup becomes a local composite action — no inputs needed (the
`EXPO_PUBLIC_*` vars stay workflow-level `env`, which composite steps inherit; no
secrets involved). Checkout stays in each job: a local action can't run before the repo
that defines it is checked out.

```yaml
# .github/actions/android-rn-setup/action.yml
name: Android RN setup
description: Shared setup for android-pr-rn jobs
runs:
  using: composite
  steps:
    # existing steps, moved verbatim, each `run:` step gaining `shell: bash`:
    # setup-vp → vp install --frozen-lockfile → setup-java (temurin 21) →
    # setup-android + sdkmanager licenses/components →
    # actions/cache/restore (fix 1 block) → write packages/mobile/.env →
    # vp exec expo prebuild --platform android --clean --no-install
    #   (prebuild keeps its step-level `env: TAILSCALE_HOSTS: ''` — step env
    #   travels with the step into the composite; don't drop it, or both jobs
    #   pay the 2 s tailscale-probe timeout again)
```

- **Cost:** the ~2 min setup block runs twice, in parallel, on free public-repo runners —
  wall time unaffected. The implementation extracts the shared setup into a local
  composite action (under `.github/actions/`), so a future setup change (new env var,
  SDK bump) stays a single edit rather than two.
- **No artifacts from cancelled runs — unchanged.** `cancel-in-progress: true` kills
  both jobs on a superseding push before the upload step, exactly as it kills the single
  job today. The `if: always()` upload only covers step failures within a completed job.
- **The "tests surface fast" intent survives and improves.** The current ordering exists
  so a test regression shows before the slow build; after the split the test job reports
  in ~5 min standalone instead of at minute 4–10 of a 21-min job, and test vs build
  failures are distinguishable at a glance in the checks list.

## Companion one-liner: `patches/**` is missing from the trigger paths

Spotted while writing this spec: `android-apk-rn.yml` triggers on `patches/**` (pnpm
patches to mobile native deps live at the repo root), but `android-pr-rn.yml` does not.
A PR that only changes a patch file skips the PR native build and the breakage lands
directly on `main`'s release build — the exact class of failure this workflow exists to
catch. This ships in the same implementation PR as fixes 1–2 — it's a one-line `paths:`
addition, nothing to defer. (The cache key needs no change: pnpm records patched
dependency hashes in `pnpm-lock.yaml` and their mappings in `pnpm-workspace.yaml`;
both are already hashed.)

## Fix 3: skip the native build on JS-only PRs and branch pushes (maintainer decision)

Decided in review (@marcodejongh): JS-only changes shouldn't build the Android or iOS
apps — `main` already skips the native build for JS-only merges, and PRs should behave
the same. His review added a second half: **skip the JS-only branch-push builds too** —
`ios-rn-ci.yml` builds on every non-`main` branch push, which "only builds on branches
because I didn't have OTA at the beginning," and no longer needs to for JS-only changes.
A JS-only change can't break the native compile (Metro bundling is separately covered by
`check:mobile-bundle` in ci.yml), and JS testing rides the `pr-<number>` OTA channels, so
losing the sideload APK on JS-only runs is acceptable. This supersedes the earlier
draft's lean toward keeping the job.

**Mirror `main`'s principle, not its mechanism.** `android-apk-rn.yml`'s gate resolves
the Expo fingerprint and skips when a `fingerprint-android-<hash>` tag says that native
shape already shipped. That exact lookup can't run on PRs: the production fingerprint
depends on Production-environment secrets (`GOOGLE_MAPS_API_KEY` perturbs it), which PR
runs — fork PRs especially — can't read, so a PR-side resolve would never match the
shipped tags. The env-consistent equivalent: **resolve the fingerprint twice with this
workflow's own env — once at HEAD, once at `main` — and skip when they're equal** (same
env on both sides, so env differences cancel; only real native-input changes move the
comparison). Diffing against `main` is uniform for both event types: it's `base.sha` for
a PR's merge ref and the merge target for a branch push.

Shape, mirroring the release workflow's `gate` → `needs:` pattern:

- A `gate` job (~30 s–2.5 min) decides `should_build`, diffing against a shallow-fetched
  `main` tip (`git diff <main> HEAD` compares the two trees directly — no merge-base or
  full history needed, so it works on both a PR merge ref and a branch push):
  1. **Path screen (fast):** if none of the canonical native-input files changed vs
     `main` (`packages/mobile/package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `app.config.ts`, `plugins/`,
     `modules/`, `patches/` — the set `ios-rn-ci`'s Pods cache key already hashes), skip
     without resolving anything. This is the exit ~every JS-only run takes. A change to
     the workflow/action plumbing forces a build so it's exercised.
  2. **Fingerprint diff (only when a candidate changed):** resolve HEAD + `main`
     fingerprints and compare — this is what correctly skips e.g. a `pnpm-lock.yaml` churn from
     a web-only dependency bump. Implementation note: the `main` resolve needs that
     revision's `node_modules` (config plugins execute at resolve time), so the gate
     `vp install`s in an isolated `git worktree` for `main` (never mutating the primary
     checkout). Fail-open: any resolve / install / worktree error builds.
  - A plain `git diff` path screen (not `dorny/paths-filter`) keeps one mechanism for
    both PRs and pushes and needs no `pull-requests` permission.
- `robolectric-tests` and `build-apk` gain `needs: gate` +
  `if: needs.gate.outputs.should_build == 'true'`. The Robolectric tests are correctly
  gated too — they test Kotlin module code, which only native inputs can change.
- **`ios-rn-ci.yml` gets the same gate** (it runs a full `xcodebuild build-for-testing`
  on macOS today), on both its `pull_request` and its branch-`push` triggers,
  `--platform ios`. The gate runs on **ubuntu**, so a skipped iOS run spends no macOS
  minutes.
- Cost on native-input runs: the gate prefixes the critical path (~2–2.5 min with the
  fingerprint resolve), taking the warm-cache path from ~12.5 to ~14–15 min. Native-input
  runs are the minority; the majority drop from ~21 min to zero.

## Expected outcome

Rows split by what the fix-3 gate decides (JS-only vs native-input); within native-input
PRs, by cache state — the real effect of fix 1 is flipping which cache state is the norm,
so "typical" and "best" converge there:

| PR type / cache state       | Today                                               | After 1 + 2 + 3                                                                                                                         |
| --------------------------- | --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| JS-only PR (the majority)   | ~21 min — **the norm**                              | **skipped** (~30 s gate) — the PR tail becomes CI's ~7.5 min                                                                            |
| Native-input PR, warm cache | ~15 min — rare (same-PR repush, if not yet evicted) | **~14–15 min — the norm** (~12.5 min build restored from `main` + ~2 min gate; exact vs prefix cache hit differ by well under a minute) |
| Native-input PR, cold cache | ~21–23 min                                          | ~17–18 min — rare (`main`'s cache evicted or stale)                                                                                     |

For the majority of mobile PRs the Android build stops being the tail entirely. On
native-input PRs it stays the longest check but drops ~6–8 min, and the wait after the
last review-fix push shrinks accordingly.

## Not doing (and why)

- **Larger runners.** The 10.7-min native compile would parallelise well on 8/16-core
  runners, but those are paid even for public repos; the standard runners are free.
- **Self-hosted runners.** Unsafe for `pull_request` workloads — fork PRs run untrusted
  code, and this repo accepts fork PRs.
- **Touching `cancel-in-progress`.** Correct as-is; superseded builds should die.

## Validation & rollback

0. **Required-check names:** fix 2 renames the job, so any branch-protection or ruleset
   entry requiring `prebuild-and-build` must switch to the two new job names in the same
   change, or the gate goes stale. As of 2026-07-03 no ruleset-based required status
   checks exist on `main` (`gh api repos/boardsesh/boardsesh/rules/branches/main` is
   empty; classic branch protection needs an admin to confirm), so this is likely a
   no-op — but treat the confirmation as a blocking pre-merge item on the
   implementation PR: re-run that command (plus an admin check of classic branch
   protection) and paste the output into the implementation PR description so the
   confirmation is reviewable, not word-of-mouth.
1. Implement all three fixes on a branch; open a PR touching **native inputs** (e.g. a
   `plugins/**` comment tweak).
2. Confirm the gate resolves `should_build=true`, the restore step logs a hit on
   `Linux-gradle-rn-*`, and no `Post Cache` save runs.
3. Push a second commit; confirm both pushes land in the ~14–15 min range and
   `gh cache list` shows no new `gradle-rn-pr-` entries.
4. Gate checks, one PR each: a JS-only diff (gate skips both Android jobs + the iOS
   build via the path screen, ~30 s); a web-only dependency bump that churns `pnpm-lock.yaml`
   (path screen escalates, fingerprint diff comes back equal → skip); a native-input
   change (fingerprints differ → build).
5. After merge, watch a week of mobile PRs: the `gradle-rn-` / `gradle-rn-dev-` caches
   should persist on `main` (LRU refreshed by every native-PR restore), most PRs should
   show the ~30 s gate skip, and native-PR durations should settle around 14–15 min.

Rollback is a single revert; caches repopulate automatically either way.
