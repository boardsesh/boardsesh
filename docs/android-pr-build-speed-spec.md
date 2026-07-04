# Android PR build: stop paying for a cold Gradle cache on every PR

Status: proposal for review · Surface: CI only (`.github/workflows/android-pr-rn.yml`) ·
No change to what the job verifies, no change to release/dev-client builds.
All numbers from `gh run list` / `gh run view` / `gh cache list` on 2026-07-03; run ids
cited so everything is re-checkable.

## TL;DR

`Android PR Build (React Native) / prebuild-and-build` is the merge-blocking tail on
essentially every mobile PR: **~21 min typical, ~15 min best case**, vs ~7.5 min for the
next-longest check (CI). It can't start any earlier — it already starts at t=0 with every
other workflow (single job, no `needs:`, runner pickup ~20 s). The duration is the
problem, and most of it is avoidable with two config-only changes:

1. **Restore-only Gradle cache, warmed by `main`.** Today every PR run saves its own
   3.4 GB cache under a PR-only key prefix. Those saves blow the repo's 10 GB cache
   budget, evict each other *and* `main`'s caches, and a new PR can never inherit a warm
   cache — so cold builds are the norm. Meanwhile `main` already builds a perfectly good
   cache on every mobile merge; PR runs just can't reach it.
2. **Robolectric tests in a parallel job.** They currently run serially before the APK
   build in the same job, adding their full 2.5–7.5 min to the critical path for no
   ordering reason.

Expected result: typical run **~21 min → ~12.5–13 min**, worst case ~23 → ~16. Free
runners, no signal lost, one-revert rollback. There's one genuinely open product-ish
question at the end (should JS-only PRs run this job at all?) that this doc deliberately
does *not* bundle in.

## The problem

For one sampled mobile PR commit (`e5f07c5`, PR #3436), every PR workflow was created at
the same second (23:27:48Z) and finished:

| Workflow                 | Duration                                 |
| ------------------------ | ---------------------------------------- |
| Mobile OTA Compatibility | 1m 23s                                   |
| iOS CI (React Native)    | 4m 31s                                   |
| Mobile OTA Preview       | 5m 53s                                   |
| CI                       | 7m 23s                                   |
| **Android PR Build**     | **15m 12s** (a *warm-cache* run — its best case) |

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

  | Step                              | Warm    | Cold                 |
  | --------------------------------- | ------- | -------------------- |
  | checkout → SDK setup → prebuild   | ~1m 30s | ~1m 00s              |
  | Gradle cache restore              | 31s     | 0s (nothing found)   |
  | Robolectric module tests          | 2m 35s  | 7m 32s               |
  | `assembleRelease` (arm64-only)    | 10m 43s | 13m 03s              |
  | cache save (post step)            | ~1s (hit, skipped) | 40s       |

  The delta is dependency downloads, the Gradle distribution, and artifact transforms,
  paid inside both Gradle steps.
- **The PR cache key prefix can never exist on `main`.** The job caches
  `~/.gradle/caches` + `~/.gradle/wrapper` under
  `${{ runner.os }}-gradle-rn-pr-${{ hashFiles('packages/mobile/package.json', 'bun.lock') }}`,
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
    key: ${{ runner.os }}-gradle-rn-${{ hashFiles('packages/mobile/package.json', 'bun.lock') }}
    restore-keys: |
      ${{ runner.os }}-gradle-rn-
```

- **Every PR run — first push included — restores the cache `main` last built.** Exact
  hit when `bun.lock` / `packages/mobile/package.json` match `main`; prefix fallback
  otherwise (Gradle re-downloads only the delta). The prefix also matches the dev-client
  cache as a secondary fallback.
- **PR runs stop saving.** The repo drops back under the 10 GB budget, so `main`'s caches
  stop being evicted — that persistence is what makes the restore reliable. The 40 s
  post-step save disappears from PR runs too.
- **Every PR restore refreshes the release cache's LRU timestamp**, protecting it from
  eviction by unrelated cache churn.

**Why the key separation stops mattering.** The current comment in the workflow says the
prefixes are separate "so a debug-signed cache never masks a release-build regression
(and vice versa)". Both directions are covered:

- *PR (debug-signed) cache masking a release regression:* impossible after this change —
  PR runs never write a cache, so nothing debug-signed is ever stored. (It was already
  impossible before, for a different reason: caches created on a PR ref are invisible to
  `main` runs.)
- *Release cache masking a PR regression:* `~/.gradle/caches` + `~/.gradle/wrapper` hold
  dependency jars, artifact transforms, and the Gradle distribution — no task outputs, no
  signing state (`org.gradle.caching` is not enabled in this project). Restoring them
  can't change what the PR build compiles or verifies, only how fast dependencies
  resolve.

The release and dev-client workflows are untouched: same keys, same save behaviour.

**Residual risk:** if `main`'s cache is evicted anyway (long stretch without mobile
merges plus heavy churn elsewhere), PR builds degrade to today's cold behaviour — no
worse. The next mobile merge (or a manual `workflow_dispatch` of `android-apk-rn.yml`)
repopulates it.

## Fix 2: run the Robolectric tests in a parallel job

The test step and `assembleRelease` are independent Gradle invocations — the tests
compile the debug variant of the live-activity module, the APK build compiles release.
Nothing is shared but the setup. Splitting them into two jobs with no `needs:` between
them takes the tests off the critical path entirely:

```yaml
jobs:
  robolectric-tests: # ~5 min wall, off the critical path
    runs-on: ubuntu-latest
    timeout-minutes: 20
    steps:
      # identical setup block: checkout, bun install, Java, Android SDK,
      # cache restore (fix 1), .env, expo prebuild
      - name: Run live-activity module unit tests (Robolectric)
        # existing step, moved verbatim (incl. the project-discovery logic)

  build-apk: # critical path: ~12.5 min warm
    runs-on: ubuntu-latest
    timeout-minutes: 45
    steps:
      # identical setup block
      - name: Build debug-signed release APK
        # existing step, unchanged
      - name: Upload sideloadable APK
        # existing step, unchanged (if: always())
```

- **Cost:** the ~2 min setup block runs twice, in parallel, on free public-repo runners —
  wall time unaffected. If the duplication bothers on review, the setup block can become
  a local composite action; not required for the win.
- **The "tests surface fast" intent survives and improves.** The current ordering exists
  so a test regression shows before the slow build; after the split the test job reports
  in ~5 min standalone instead of at minute 4–10 of a 21-min job, and test vs build
  failures are distinguishable at a glance in the checks list.

## Expected outcome

| Scenario                                                  | Today   | After 1 + 2      |
| --------------------------------------------------------- | ------- | ---------------- |
| Typical PR push (new PR, or sibling PR evicted the cache) | ~21 min | **~12.5–13 min** |
| Best case                                                 | ~15 min | ~12.5 min        |
| Worst case (`main` cache evicted)                         | ~23 min | ~16 min          |

The Android build likely stays the longest mobile check, but the gap to CI (~7.5 min)
shrinks from ~3× to well under 2×, and the wait after the last review-fix push drops by
~8 min in the common case.

## Open question (not bundled here): should JS-only PRs run this job at all?

A JS-only mobile change can't break the native Gradle compile, and Metro bundling is
already covered by `check:mobile-bundle` in ci.yml. Path-scoping the trigger to native
inputs only (`app.config.ts`, `plugins/**`, `modules/**`, `package.json`, `patches/**`,
`bun.lock` — the same globs the iOS screenshot cache keys on) would remove the 15–21 min
job from the majority of mobile PRs entirely.

The trade-off is real, though: JS-only PRs would lose the per-PR sideloadable APK
artifact. Testers mostly ride the `pr-<number>` OTA channels for JS testing, so the
artifact may be vestigial — but that's a judgement call about what signal and artifacts a
PR should always produce, not a pure speed win. Deliberately left out of this change;
worth deciding separately.

## Not doing (and why)

- **Larger runners.** The 10.7-min native compile would parallelise well on 8/16-core
  runners, but those are paid even for public repos; the standard runners are free.
- **Self-hosted runners.** Unsafe for `pull_request` workloads — fork PRs run untrusted
  code, and this repo accepts fork PRs.
- **Touching `cancel-in-progress`.** Correct as-is; superseded builds should die.

## Validation & rollback

1. Implement both fixes on a branch; open a PR touching `packages/mobile/**`.
2. Confirm the restore step logs a hit on `Linux-gradle-rn-*` and no `Post Cache` save
   runs.
3. Push a second commit; confirm both pushes land in the 12–14 min range and
   `gh cache list` shows no new `gradle-rn-pr-` entries.
4. After merge, watch a week of mobile PRs: the `gradle-rn-` / `gradle-rn-dev-` caches
   should persist on `main` (LRU refreshed by every PR restore) and Android PR durations
   should settle around 12–13 min.

Rollback is a single revert; caches repopulate automatically either way.
