# Android emulator screenshots (local, dev-client + Metro)

Quick screenshots of the live React Native app (`packages/mobile/`) on an Android
emulator, driven against a Metro dev server using a cached dev-client APK. This is the
Android counterpart to the iOS simulator flow (`vp run mobile:screenshots`) and works on
Linux: an x86_64 emulator runs natively on a host with KVM (`/dev/kvm`), so it's the fast
path on Linux/Intel.

The cached APK carries no JS — it loads from Metro at runtime — so JavaScript changes show
up on the next reload without rebuilding the APK. Native deps change rarely, so the same
cached APK serves run after run.

## One-time setup

Everything installs under `~/.cache/boardsesh/` (SDK, a Temurin JDK 21, the downloaded
APK). On a clean box, the first `vp run mobile:android-shots` bootstraps it automatically.
To do it up front and see a diagnostics report:

```
vp run mobile:android-doctor          # bootstrap SDK + JDK 21, report status
vp run mobile:android-doctor -- --build   # also install build-tools (local APK fallback)
vp run mobile:android-doctor -- --check   # report only, install nothing
```

Requirements the doctor checks: `/dev/kvm` (fast emulation), an authenticated `gh` (to
download the cached APK), and — only for `--flow` runs — `maestro` on PATH.

## Take screenshots

One-shot (boot, capture one screen, tear down):

```
vp run mobile:android-shots -- --to climbs --label climbs --shutdown
```

Iterative (boot once, shoot many). Run the bare command in the background so it holds
Metro + the emulator alive, then grab shots in the foreground:

```
vp run mobile:android-shots                                  # background this; it holds Metro
vp run mobile:android-shots -- screenshot --to board-view --label board
vp run mobile:android-shots -- screenshot --to profile --label profile
vp run mobile:android-shots -- navigate --to discover        # deep-link only, no capture
vp run mobile:android-shots -- shutdown                       # stop emulator + Metro
```

PNGs land in `.boardsesh/android-screenshots/NN-<label>.png` (gitignored); the absolute
path is printed so it can be shared directly.

### Screens (`--to`)

`--to` accepts a friendly name or a raw deep-link route:

| Name             | Route                               | Screen                  |
| ---------------- | ----------------------------------- | ----------------------- |
| `home`           | `home`                              | Feed                    |
| `climbs`         | `climbs`                            | Browse list             |
| `board-view`     | `climbs?screenshotOpenFirst=1`      | First climb on the wall |
| `board-sheet`    | `climbs?screenshotOpenBoardSheet=1` | Board-presence sheet    |
| `discover`       | `discover`                          | Playlist library        |
| `record`         | `record`                            | Workout generator       |
| `profile`        | `profile`                           | Profile / progress      |
| `session-detail` | `profile?screenshotTab=sessions`    | Newest session recap    |
| `logbook`        | `profile?screenshotTab=logbook`     | Climbing history        |

The `screenshot*` params are app code (`packages/mobile/src/lib/screenshot-mode.ts`), so
they work the same as in the Maestro flows. Pass any raw route to `--to`, e.g.
`--to 'climbs?screenshotBoardIndex=1'`.

## The APK

By default the tool downloads the latest `rn-android-dev-*` prerelease asset
(`boardsesh-dev-android.apk`, package `com.boardsesh.app.dev`) and caches it, then verifies
it carries the `x86_64` ABI. The CI dev-client APK is **universal** (`arm64-v8a` + `x86_64`)
— see `docs/android-sideload-build.md` and `.github/workflows/android-apk-dev-client.yml`.

If the download is unavailable, the APK lacks `x86_64`, or you pass `--build-local`, the
tool builds a dev-client APK locally (`BOARDSESH_APP_VARIANT=dev` prebuild +
`gradlew assembleDebug` for `x86_64`) and caches it by a hash of the native inputs. The
local build needs JDK 21 (auto-provisioned) and is slow the first time (NDK + Hermes).

```
vp run mobile:android-apk                       # download (or build) and print the path
vp run mobile:android-apk -- --build-local      # force a local Gradle build
vp run mobile:android-apk -- --apk-tag rn-android-dev-42
```

## Login state

By default `EXPO_PUBLIC_SCREENSHOT_MODE` is on: the app auto-logs-in the test account
(`test@boardsesh.com`) against prod and locks the dark theme, so board-backed screens show
real content with no taps. Set `SCREENSHOT_USER_PASSWORD` to the prod test account password
(the seeded `test`/`test` pair only exists on the local dev backend — use `--backend local`
with `vp run dev` for that). Pass `--no-screenshot-mode` for the plain app where you drive
login yourself.

## Flags

| Flag                             | Default                          | Meaning                                       |
| -------------------------------- | -------------------------------- | --------------------------------------------- |
| `--to <screen>`                  | –                                | Navigate before capturing (name or raw route) |
| `--label <name>`                 | `--to` value                     | Screenshot filename label                     |
| `--out <dir>`                    | `.boardsesh/android-screenshots` | Output directory                              |
| `--shutdown`                     | off (keep-alive)                 | Tear down emulator + Metro after the run      |
| `--no-screenshot-mode`           | off                              | Plain dev-client (shows login)                |
| `--flow <app-store\|onboarding>` | –                                | Run the Maestro flow instead of ad-hoc        |
| `--build-local`                  | off                              | Force a local Gradle APK build                |
| `--apk-tag <tag>`                | latest                           | Pin the downloaded release tag                |
| `--app-path <apk>`               | –                                | Use a specific APK                            |
| `--backend <prod\|local>`        | `prod`                           | Backend the app points at                     |
| `--windowed`                     | off (headless)                   | Boot the emulator with a window               |
| `--settle <seconds>`             | `3`                              | Wait after navigation before capturing        |

## Environment overrides (headless / CI hosts)

The emulator's GPU renderer is the most host-sensitive part. Defaults match the repo's
CI (`-gpu swiftshader_indirect`, KVM via `-accel auto`), and on a headless Linux box the
tooling auto-wraps the emulator in `xvfb-run` when there's no `$DISPLAY`. Tune via env:

| Env                               | Default                | Use                                               |
| --------------------------------- | ---------------------- | ------------------------------------------------- |
| `BOARDSESH_EMULATOR_GPU`          | `swiftshader_indirect` | Renderer (`guest` → host lavapipe, `host`, `off`) |
| `BOARDSESH_AVD_NAME`              | `boardsesh-pixel`      | Point at a pre-made AVD (e.g. an `aosp_atd` one)  |
| `BOARDSESH_EMULATOR_EXTRA_ARGS`   | –                      | Extra `emulator` flags (space-separated)          |
| `BOARDSESH_EMULATOR_BOOT_TIMEOUT` | `300`                  | Boot wait in seconds (raise for slow/TCG hosts)   |
| `BOARDSESH_METRO_PORT`            | `8081`                 | Metro port (per worktree)                         |
| `SCREENSHOT_USER_PASSWORD`        | `test`                 | Prod test account password for auto-login         |

Requirements for a fast emulator: a host with `/dev/kvm` (KVM), and a working software
GPU renderer. On a normal dev machine or a standard CI runner (e.g. GitHub Actions
`ubuntu-latest`, which is what `.github/workflows/mobile-screenshots.yml` already uses for
the Android job) `swiftshader_indirect` works out of the box. Some heavily-sandboxed or
exotic-CPU VMs can't run the emulator's software GPU at all (it segfaults during
rendering); there's no software-only fallback for that — run the flow on a normal host/CI.

## Gotchas

- Deep links and the dev-client launch URL use scheme `com.boardsesh.app://` for both prod
  and dev variants; only the installed **package** differs (`com.boardsesh.app.dev`). See
  the comment at `packages/mobile/app.config.ts:111-114`.
- `EXPO_PUBLIC_*` are inlined at JS-bundle time, so Metro is started with the screenshot env
  baked in — the tool handles this; you don't set them after Metro is up.
- Native Google Sign-In isn't registered for `com.boardsesh.app.dev`; use the email/password
  auto-login path (the default).
- `--flow` runs the committed Maestro flows with `-e APP_ID=com.boardsesh.app.dev` so
  `launchApp` targets the dev-client package.
