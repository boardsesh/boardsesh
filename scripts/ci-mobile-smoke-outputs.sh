#!/usr/bin/env bash
# Turn the navigation smoke's result file into job outputs for
# .github/workflows/mobile-e2e-gate.yml, so the verdict can say WHY a smoke
# failed and count the launch crash separately. Both smoke jobs run this with
# `if: always()`.
#
# The orchestrator (scripts/mobile-screenshots.ts --flow smoke) writes the file;
# its shape is SmokeResult in scripts/lib/mobile-smoke.ts.
set -euo pipefail

result="${SMOKE_RESULT_PATH:-.boardsesh/smoke-result.json}"
if [ ! -f "$result" ]; then
  # The job died before the smoke could judge anything (toolchain, APK, cache).
  echo "failure_label=no smoke result: the job failed before the smoke ran" >> "$GITHUB_OUTPUT"
  echo "::warning::No smoke result at $result."
  exit 0
fi

{
  echo "failure_class=$(jq -r '.failureClass // ""' "$result")"
  echo "failure_label=$(jq -r '.failureLabel // ""' "$result")"
  echo "native_crash_at_launch_count=$(jq -r '.nativeCrashAtLaunchCount' "$result")"
} >> "$GITHUB_OUTPUT"
cat "$result"
