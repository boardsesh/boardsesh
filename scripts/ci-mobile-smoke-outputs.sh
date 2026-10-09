#!/usr/bin/env bash
# Turn the navigation smoke's result file into job outputs for
# .github/workflows/mobile-e2e-gate.yml, so the verdict can say WHY a smoke
# failed and count the launch crash separately. Both smoke jobs run this with
# `if: always()`.
#
# The orchestrator (scripts/mobile-screenshots.ts --flow smoke) writes the file;
# its shape is SmokeResult in scripts/lib/mobile-smoke.ts.
set -euo pipefail

write_output() {
  local output_name="$1" output_content="$2"
  local delimiter="SMOKE_${RANDOM}_${RANDOM}_$$"
  while [[ "$output_content" == *"$delimiter"* ]]; do
    delimiter="SMOKE_${RANDOM}_${RANDOM}_$$"
  done
  printf '%s<<%s\n%s\n%s\n' "$output_name" "$delimiter" "$output_content" "$delimiter" >> "$GITHUB_OUTPUT"
}

result="${SMOKE_RESULT_PATH:-.boardsesh/smoke-result.json}"
if [ ! -f "$result" ]; then
  write_output failure_label 'no smoke result: the job failed before the smoke ran'
  echo "::warning::No smoke result at $result."
  exit 0
fi

write_output failure_class "$(jq -r '.failureClass // ""' "$result")"
write_output failure_label "$(jq -r '.failureLabel // ""' "$result")"
write_output native_crash_at_launch_count "$(jq -r '.nativeCrashAtLaunchCount' "$result")"
cat "$result"
