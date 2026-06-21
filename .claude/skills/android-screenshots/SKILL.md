---
name: android-screenshots
description: Capture screenshots of the Boardsesh React Native app (packages/mobile/) running on an Android emulator, driven against Metro with a cached dev-client APK. Use when asked to screenshot / see / visually verify the mobile app on Android, or to share mobile screenshots in chat. Linux/KVM-friendly; the iOS counterpart is `vp run mobile:ios-shots` (full App Store matrix: `vp run mobile:screenshots`). Full reference: docs/android-emulator-screenshots.md.
---

# Android emulator screenshots

Boots a headless x86_64 emulator, installs a cached **dev-client** APK (no bundled JS — it
loads from Metro), runs the app, and captures with `adb exec-out screencap`. The APK is
built/downloaded once and reused; only the JS regenerates per run.

## Workflow (preferred: boot once, shoot many)

1. **First run only — bootstrap.** `vp run mobile:android-doctor` installs the Android SDK and a
   Temurin JDK 21 under `~/.cache/boardsesh/` (~2.5 GB, one-time) and reports KVM / JDK / AVD /
   cached-APK status. Skip on subsequent runs (the main command auto-bootstraps anyway).

2. **Pick login/data state:**
   - **Prod test account (default):** export `SCREENSHOT_USER_PASSWORD=<prod test pw>` so the app
     auto-logs-in `test@boardsesh.com` and shows real content. Without it, the app stops on the
     login screen.
   - **Local seeded data:** run `vp run dev` first, then add `--backend local` (seeded `test`/`test`).
   - **Plain app (drive login yourself):** add `--no-screenshot-mode`.

3. **Boot in the BACKGROUND.** The bare command holds Metro and blocks, so launch it with the
   Bash tool's `run_in_background: true`:
   `vp run mobile:android-shots` (plus `--backend local` / `--no-screenshot-mode` as chosen).
   It boots the emulator, installs the APK (downloads the universal `rn-android-dev-*` release or
   builds an x86_64 dev-client locally), starts Metro, `adb reverse`, and launches the app.

4. **Wait for "Ready".** Poll the background task's output file (returned when you launched it)
   with a second `run_in_background` Bash `until`-loop so you get one notification:
   `until grep -qE "Ready\. Emulator|FAILED|did not finish booting" <output-file>; do sleep 3; done`

5. **Capture (foreground).** For each screen:
   `vp run mobile:android-shots -- screenshot --to <screen> --label <name>`
   It navigates via deep link, captures, and prints the absolute PNG path. Screen names:
   `home`, `climbs`, `board-view`, `board-sheet`, `discover`, `record`, `profile`,
   `session-detail`, `logbook` — or pass a raw route, e.g. `--to 'climbs?screenshotBoardIndex=1'`.

6. **Share.** `SendUserFile` each printed PNG path.

7. **Stop when done.** `vp run mobile:android-shots -- shutdown` (kills emulator + Metro), and
   stop the backgrounded boot task.

## One-shot alternative (simplest, slower per shot)

`vp run mobile:android-shots -- --to climbs --label climbs --shutdown` — boots, captures one
screen, tears down, and exits in a single (long) foreground call. No emulator reuse, so prefer
the background workflow for multiple shots.

## Useful flags & env

- `--flow app-store|onboarding` runs the committed Maestro flows instead of ad-hoc capture.
- `--app-path <apk>` / `--apk-tag <tag>` / `--build-local` to control APK resolution.
- Env: `BOARDSESH_EMULATOR_GPU` (renderer), `BOARDSESH_AVD_NAME`, `BOARDSESH_EMULATOR_BOOT_TIMEOUT`,
  `BOARDSESH_METRO_PORT`. See `docs/android-emulator-screenshots.md` for the full table.

## Requirements & troubleshooting

- Needs a host with `/dev/kvm` (fast emulation) and a working software GPU renderer. On normal
  dev machines and standard CI (GitHub Actions `ubuntu-latest`, used by the repo's Android
  screenshot job) `swiftshader_indirect` works out of the box.
- **Emulator exits immediately / "did not finish booting":** check `.boardsesh/android-emulator.log`.
  If the renderer segfaults, some heavily-sandboxed or exotic-CPU VMs can't run the emulator's
  software GPU at all — there's no software-only fallback; run on a normal host/CI. If running
  inside a sandboxed agent environment and qemu dies instantly, the Bash sandbox may be blocking
  its KVM/memory syscalls — retry the boot with the sandbox disabled.
- Screenshots land in `.boardsesh/android-screenshots/NN-<label>.png` (gitignored).
