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
#   SCREENSHOT_FLOW            app-store | onboarding | smoke   (default app-store)
#   SCREENSHOT_ANDROID_DEVICE  output device label      (default "Pixel 2")
#   SCREENSHOT_APK_PATH        dev-client APK to install (required, no default)
#   SCREENSHOT_DEV_CLIENT      '1' to pass --dev-client to the orchestrator
#   SCREENSHOT_RENDER_MODE     board drawing            (empty = the app default, Aura)
#   SCREENSHOT_BOARDS          "|"-separated walls      (empty = the app default)
#   SCREENSHOT_FIXTURES        replay | record | live   (default replay = serve the committed fixture set)
#   SCREENSHOT_FROZEN_NOW      record only: ISO instant to freeze "now" at (empty = mint one)
#   SCREENSHOT_ATTEMPTS        how many times to run the orchestrator (default 3). The E2E
#                              gate's smoke passes 1: the orchestrator owns its one retry
#                              there, and only for a native crash at launch.
#   ANDROID_CAPTURE_EMULATOR_OPTIONS  the runner's `emulator-options`, set once in
#                              .github/actions/android-emulator-capture; used to relaunch
#                              the same AVD when the emulator dies between attempts.
#   SCREENSHOT_AVD_NAME        the AVD the runner created (default "test", the action's default)
set -euo pipefail

flow="${SCREENSHOT_FLOW:-app-store}"
device="${SCREENSHOT_ANDROID_DEVICE:-Pixel 2}"
apk_path="${SCREENSHOT_APK_PATH:-}"
if [ -z "$apk_path" ]; then
  echo "::error::SCREENSHOT_APK_PATH is required (no default APK path any more)."
  exit 1
fi
if [ ! -f "$apk_path" ]; then
  echo "::error::SCREENSHOT_APK_PATH=$apk_path does not exist."
  exit 1
fi

# The dev-client APK has no bundled JS — it loads from the Metro dev server the
# orchestrator starts, so these values have to reach the orchestrator (which
# puts them in Metro's env) rather than a JS bundle baked at build time. The
# capture gate checks the app drew what the run asked for, so without them a
# `render_mode=classic` run fails itself: the app reports "classic", the gate
# still expects the default, and a legitimate comparison capture reds out.
# Empty means neither side overrides anything.
retarget=()
if [ -n "${SCREENSHOT_RENDER_MODE:-}" ]; then
  retarget+=(--render-mode "$SCREENSHOT_RENDER_MODE")
fi
if [ -n "${SCREENSHOT_BOARDS:-}" ]; then
  retarget+=(--boards "$SCREENSHOT_BOARDS")
fi
if [ "${SCREENSHOT_DEV_CLIENT:-}" = "1" ]; then
  retarget+=(--dev-client)
fi

# The record/replay backend. `replay` (the default) serves the committed fixture
# set, so captures are deterministic. `live` passes nothing, so the capture talks
# to PROD exactly as it did before fixtures existed. A recording run starts from
# an empty set so what it uploads is only what THIS capture asked for; the merge
# step unions it with the iOS shards.
fixtures="${SCREENSHOT_FIXTURES:-replay}"
if [ "$fixtures" != "live" ]; then
  retarget+=(--fixtures "$fixtures")
  if [ "$fixtures" = "record" ]; then
    retarget+=(--fresh)
    if [ -n "${SCREENSHOT_FROZEN_NOW:-}" ]; then
      retarget+=(--frozen-now "$SCREENSHOT_FROZEN_NOW")
    fi
  fi
fi

# Diagnostics land here; the workflow uploads it as an artifact (always()). The
# device-side app logs (network errors, screen markers) are the only window into
# why a screen captured empty, since the emulator is killed when this step ends.
debug_dir="${GITHUB_WORKSPACE:-$PWD}/android-capture-debug"
mkdir -p "$debug_dir"
# The orchestrator copies the PNGs Maestro shot before a failure here, plus the
# screenshot backend's own log (see preserveFailedRunArtifacts in
# scripts/mobile-screenshots.ts).
export SCREENSHOT_DEBUG_DIR="$debug_dir"

logcat_pid=""
cleanup() {
  [ -n "$logcat_pid" ] && kill "$logcat_pid" 2>/dev/null || true
  # Maestro writes the view hierarchy + failure screenshot under ~/.maestro/tests;
  # copy it out (best-effort) so we can see what Maestro could match on a failure.
  cp -R "$HOME/.maestro/tests" "$debug_dir/maestro-tests" 2>/dev/null || true
  # The emulator's own crash reports, when the host process died (best-effort).
  cp /tmp/android-runner/emu-crash-*.db "$debug_dir/" 2>/dev/null || true
}
trap cleanup EXIT

# Stream the app's logcat to a file (appended, so a relaunched emulator's log
# follows the first one). Backgrounded; killed in cleanup.
start_logcat() {
  adb logcat -v time >> "$debug_dir/logcat.txt" 2>&1 &
  logcat_pid=$!
}

# Display and animation setup for a booted emulator. Runs once up front and
# again after a relaunch, which comes back with the AVD's defaults.
prepare_device() {
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

  local wm_ready=0 wm_attempt
  # Its own counter: this also runs inside the capture retry loop's `attempt`.
  for wm_attempt in 1 2 3 4 5 6; do
    if adb shell wm size 1080x1920 && adb shell wm density 420; then
      wm_ready=1
      break
    fi
    echo "display setup not ready (attempt ${wm_attempt}/6); retrying in 5s…"
    sleep 5
  done
  [ "$wm_ready" = 1 ] || {
    echo "::error::adb wm display setup failed after retries"
    return 1
  }
}

emulator_alive() {
  [ "$(adb get-state 2>/dev/null)" = "device" ]
}

# The swiftshader emulator can die outright mid-flow (adb: "device offline",
# then "device 'emulator-5554' not found"): run 42580189601 lost it twice at the
# same Play-screen board render. Every later attempt then failed at `adb install`
# in a second, so the retries never ran. Boot the same AVD again with the
# runner's options so the next attempt has a phone to install on.
relaunch_emulator() {
  local emulator_options="${ANDROID_CAPTURE_EMULATOR_OPTIONS:-}"
  local avd_name="${SCREENSHOT_AVD_NAME:-test}"
  local sdk_root="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-/usr/local/lib/android/sdk}}"
  if [ -z "$emulator_options" ]; then
    echo "::error::ANDROID_CAPTURE_EMULATOR_OPTIONS is unset; cannot relaunch the emulator"
    return 1
  fi
  echo "::warning::emulator is gone; relaunching AVD ${avd_name}"
  [ -n "$logcat_pid" ] && kill "$logcat_pid" 2>/dev/null || true
  logcat_pid=""
  adb emu kill 2>/dev/null || true
  # Bracketed so the pattern never matches this shell's own command line.
  pkill -f '[q]emu-system-x86_64' 2>/dev/null || true
  sleep 3
  adb kill-server 2>/dev/null || true
  adb start-server
  # The options are a flag list; word splitting is intended.
  # shellcheck disable=SC2086
  "$sdk_root/emulator/emulator" -avd "$avd_name" $emulator_options >> "$debug_dir/emulator-relaunch.log" 2>&1 &
  timeout 300 adb wait-for-device || {
    echo "::error::relaunched emulator never reached adb"
    return 1
  }
  local booted=0
  for _ in $(seq 1 60); do
    if [ "$(adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = "1" ]; then
      booted=1
      break
    fi
    sleep 5
  done
  [ "$booted" = 1 ] || {
    echo "::error::relaunched emulator did not finish booting in 300s"
    return 1
  }
  # The runner's `disable-animations: true`, which a fresh boot does not keep.
  adb shell settings put global window_animation_scale 0.0 || true
  adb shell settings put global transition_animation_scale 0.0 || true
  adb shell settings put global animator_duration_scale 0.0 || true
  prepare_device
  start_logcat
}

adb logcat -c 2>/dev/null || true
start_logcat
prepare_device || exit 1

# Bounded retry. The dev-client cold start dies natively often enough that two
# attempts is not enough — TWO DISTINCT crashes are on record, and the store flow
# cold-launches the app four times per run:
#
#   * SIGSEGV inside React Native's Fabric mounting
#     (MountingCoordinator::pullTransaction) — CI run 34214269041, on the third
#     of four cold launches.
#   * SIGABRT from a JNI "field operation on NULL object" in
#     libexpo-modules-core.so on the mqt_v_js thread — CI run 34248313427, again
#     on a relaunch, with the app never reaching home-screen.
#
# A fresh orchestrator run reinstalls the APK, restarts Metro and reruns the
# whole flow; the emulator stays up unless it died, in which case
# relaunch_emulator boots the same AVD again first. The blank/size gates in the workflow still
# judge the final set, so a retry cannot launder a bad capture — it only covers
# a crash. Three attempts fit the job's 75-minute ceiling: APK resolve <= 19 min
# plus 3 x ~10 min of capture plus setup.
attempts="${SCREENSHOT_ATTEMPTS:-3}"
for attempt in $(seq 1 "$attempts"); do
  if vp run mobile:screenshots -- \
    --platform android \
    --flow "$flow" \
    --backend prod \
    --device "$device" \
    ${retarget[@]+"${retarget[@]}"} \
    --app-path "$apk_path"; then
    echo "capture succeeded on attempt ${attempt}/${attempts}"
    exit 0
  fi
  if [ "$attempt" -lt "$attempts" ]; then
    echo "::warning::capture attempt ${attempt}/${attempts} failed; retrying with a fresh install + Metro"
    # Let the previous orchestrator's Metro / readiness process group exit and
    # release their ports before the next attempt binds them.
    sleep 15
    if ! emulator_alive; then
      relaunch_emulator || break
    fi
  fi
done
echo "::error::capture failed after ${attempts} attempts"
exit 1
