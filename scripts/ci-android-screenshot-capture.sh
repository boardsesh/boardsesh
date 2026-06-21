#!/usr/bin/env bash
# Capture Android Play Store screenshots inside the android-emulator-runner step.
#
# reactivecircus/android-emulator-runner splits its `script:` input by newline
# and runs each line as its OWN `sh -c` (see the action's script-parser). That
# makes inline multi-line shell impossible: for-loops, cross-line variables, and
# backslash line-continuations each blow up ("Syntax error: end of file
# unexpected (expecting \"done\")"). So the capture logic lives here and the
# workflow invokes it on a single line.
#
# Inputs come from the environment (set on the workflow step):
#   SCREENSHOT_FLOW            app-store | onboarding   (default app-store)
#   SCREENSHOT_ANDROID_DEVICE  output device label      (default "Pixel 2")
#   SCREENSHOT_APK_PATH        prebuilt screenshot APK  (default /tmp/boardsesh-screenshot.apk)
set -euo pipefail

flow="${SCREENSHOT_FLOW:-app-store}"
device="${SCREENSHOT_ANDROID_DEVICE:-Pixel 2}"
apk_path="${SCREENSHOT_APK_PATH:-/tmp/boardsesh-screenshot.apk}"

# Diagnostics land here; the workflow uploads it as an artifact (always()). The
# device-side app logs (network errors, screen markers) are the only window into
# why a screen captured empty, since the emulator is killed when this step ends.
debug_dir="${GITHUB_WORKSPACE:-$PWD}/android-capture-debug"
mkdir -p "$debug_dir"

logcat_pid=""
cleanup() {
  [ -n "$logcat_pid" ] && kill "$logcat_pid" 2>/dev/null || true
  # Maestro writes the view hierarchy + failure screenshot under ~/.maestro/tests;
  # copy it out (best-effort) so we can see what Maestro could match on a failure.
  cp -R "$HOME/.maestro/tests" "$debug_dir/maestro-tests" 2>/dev/null || true
}
trap cleanup EXIT

# Stream the app's logcat to a file for the whole capture (cleared first so it's
# just this run). Backgrounded; killed in cleanup.
adb logcat -c 2>/dev/null || true
adb logcat -v time > "$debug_dir/logcat.txt" 2>&1 &
logcat_pid=$!

# `sys.boot_completed` fires before the window manager is fully up, so an
# `adb shell wm …` right after the runner reports "booted" can hit a transient
# "device offline" (exit 1). Wait for the device, then retry the display setup
# until it sticks.
adb wait-for-device

# Belt-and-suspenders: force GPU composition by disabling hardware overlays, so a
# HW-composited layer can't hide from `adb screencap`. A no-op on the swiftshader
# CI emulator (no overlays) — the board-view's actual blank-capture fix is the
# pre-screenshot redraw swipe in app-store-android.yaml — but cheap insurance for
# any HW-accelerated config. Best-effort.
adb shell service call SurfaceFlinger 1008 i32 1 2>/dev/null || true

wm_ready=0
for attempt in 1 2 3 4 5 6; do
  if adb shell wm size 1080x1920 && adb shell wm density 420; then
    wm_ready=1
    break
  fi
  echo "display setup not ready (attempt ${attempt}/6); retrying in 5s…"
  sleep 5
done
[ "$wm_ready" = 1 ] || {
  echo "::error::adb wm display setup failed after retries"
  exit 1
}

vp run mobile:screenshots -- \
  --platform android \
  --flow "$flow" \
  --backend prod \
  --device "$device" \
  --app-path "$apk_path"
