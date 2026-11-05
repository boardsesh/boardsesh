#!/usr/bin/env bash
set -Eeuo pipefail

fail() {
  printf '::error::%s\n' "$*" >&2
  exit 1
}

compile_gate() {
  local device="${CIQ_DEVICE:-}"
  local warning_baseline="${CIQ_WARNING_BASELINE:-}"
  local runner_temp="${RUNNER_TEMP:-}"

  [[ -n "$device" ]] || fail 'CIQ_DEVICE is required for the Garmin compile gate'
  [[ "$warning_baseline" =~ ^[0-9]+$ ]] || fail 'CIQ_WARNING_BASELINE must be a non-negative integer'
  [[ -n "$runner_temp" && -d "$runner_temp" ]] || fail 'RUNNER_TEMP must be an existing directory'
  [[ -f "$runner_temp/developer_key" ]] || fail 'the CI throwaway developer key is missing'

  # Keep the gradual type-check level the app is written against; -l 3 reports
  # known source errors and produces no binary. The warning count is a separate
  # bounded gate so an unrelated cleanup does not silently loosen compiler checks.
  local compile_log="$runner_temp/garmin-compile.log"
  monkeyc -f garmin/monkey.jungle -w \
    -o "$runner_temp/boardsesh.prg" \
    -y "$runner_temp/developer_key" \
    -d "$device" 2>&1 | tee "$compile_log"

  local warning_count
  warning_count="$(grep -cE '^WARNING' "$compile_log" || true)"
  printf 'monkeyc warnings: %s (baseline %s)\n' "$warning_count" "$warning_baseline"
  if (( 10#$warning_count > 10#$warning_baseline )); then
    printf '::error::monkeyc emitted %s warnings, up from %s. Fix them or explain a baseline change in this PR.\n' \
      "$warning_count" "$warning_baseline" >&2
    grep -E '^WARNING' "$compile_log" || true
    exit 1
  fi
  if (( 10#$warning_count < 10#$warning_baseline )); then
    printf '::warning::monkeyc emitted %s warnings, below the %s baseline. Lower CIQ_WARNING_BASELINE so the gate keeps its grip.\n' \
      "$warning_count" "$warning_baseline"
  fi

  if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
    {
      printf '### Garmin compile\n\n'
      printf -- '- device: `%s`\n' "$device"
      printf -- '- warnings: %s / %s baseline\n' "$warning_count" "$warning_baseline"
    } >> "$GITHUB_STEP_SUMMARY"
  fi

  # The staging jungle is the only consumer of the :staging annotation.
  monkeyc -f 'garmin/monkey.jungle;garmin/monkey-staging.jungle' -w \
    -o "$runner_temp/boardsesh-staging.prg" \
    -y "$runner_temp/developer_key" \
    -d "$device"

  # Compile the -t target so tests type-check; simulator execution stays manual.
  monkeyc -f garmin/monkey.jungle -w \
    -o "$runner_temp/boardsesh-test.prg" \
    -y "$runner_temp/developer_key" \
    -d "$device" -t
}

release_gate() {
  local expected_sha="${GITHUB_SHA:-}"
  local event_name="${GITHUB_EVENT_NAME:-}"
  local repository="${GITHUB_REPOSITORY:-}"
  local ref="${GITHUB_REF:-}"
  local gh_token="${GH_TOKEN:-}"

  [[ "$event_name" == push || "$event_name" == workflow_dispatch ]] ||
    fail "release gate does not allow event '${event_name:-unset}'"
  [[ "$ref" == refs/heads/main ]] ||
    fail "release gate only allows refs/heads/main (got '${ref:-unset}')"
  [[ "$expected_sha" =~ ^[0-9a-f]{40}$ ]] ||
    fail 'GITHUB_SHA must be a full 40-character commit SHA'
  [[ "$repository" =~ ^[^/]+/[^/]+$ ]] ||
    fail 'GITHUB_REPOSITORY must have owner/repository form'
  [[ -n "$gh_token" ]] || fail 'GH_TOKEN is required to read the Garmin CI run'

  local checked_out_sha
  checked_out_sha="$(git rev-parse HEAD)" || fail 'could not read the checked-out source SHA'
  [[ "$checked_out_sha" == "$expected_sha" ]] ||
    fail "checked-out source ${checked_out_sha} does not match workflow SHA ${expected_sha}"

  local workflow_json
  if ! workflow_json="$(gh api "repos/${repository}/actions/workflows/garmin-ci.yml")"; then
    fail 'could not look up the Garmin CI workflow identity'
  fi
  if ! jq -e '
    .path == ".github/workflows/garmin-ci.yml" and
    .name == "Garmin CI" and
    .state == "active" and
    (.id | type == "number" and . > 0)
  ' >/dev/null <<<"$workflow_json"; then
    fail 'the Garmin CI workflow identity is missing, inactive, or unexpected'
  fi

  local workflow_id
  workflow_id="$(jq -er '.id | select(type == "number" and . > 0)' <<<"$workflow_json")" ||
    fail 'the Garmin CI workflow did not return a valid workflow id'

  local max_polls="${GARMIN_CI_GATE_MAX_POLL_ATTEMPTS:-80}"
  [[ "$max_polls" =~ ^[1-9][0-9]*$ ]] ||
    fail 'GARMIN_CI_GATE_MAX_POLL_ATTEMPTS must be a positive integer'
  (( max_polls <= 80 )) || fail 'GARMIN_CI_GATE_MAX_POLL_ATTEMPTS may not exceed 80'

  local poll
  for (( poll = 1; poll <= max_polls; poll += 1 )); do
    local runs_json
    if ! runs_json="$(gh api "repos/${repository}/actions/workflows/${workflow_id}/runs?branch=main&event=push&head_sha=${expected_sha}&per_page=100")"; then
      fail 'could not read Garmin CI runs; refusing to publish'
    fi
    if ! jq -e 'type == "object" and (.workflow_runs | type == "array")' >/dev/null <<<"$runs_json"; then
      fail 'GitHub returned an invalid Garmin CI run list; refusing to publish'
    fi

    if ! jq -e --argjson workflow_id "$workflow_id" --arg sha "$expected_sha" '
      [ .workflow_runs[]? |
        select(
          .workflow_id == $workflow_id and
          .head_sha == $sha and
          .head_branch == "main" and
          .event == "push"
        )
      ]
      | all(.[];
          (.id | type == "number" and . > 0 and floor == .) and
          (.run_attempt | type == "number" and . >= 1 and floor == .) and
          (.created_at | type == "string" and length > 0) and
          (.run_started_at == null or (.run_started_at | type == "string" and length > 0))
        )
    ' >/dev/null <<<"$runs_json"; then
      fail 'GitHub returned a matching Garmin CI run without valid ordering metadata; refusing to publish'
    fi

    # Choose the newest exact-source attempt before inspecting its conclusion.
    # Compare created_at consistently: a queued newer run has no start time,
    # while an older run may start later after queueing. Run ids distinguish
    # same-second creations; run_attempt orders retries of the same run id. A
    # newer failure or in-progress run must never fall back to an older pass.
    local matching_run
    matching_run="$(jq -c --argjson workflow_id "$workflow_id" --arg sha "$expected_sha" '
      [ .workflow_runs[]? |
        select(
          .workflow_id == $workflow_id and
          .head_sha == $sha and
          .head_branch == "main" and
          .event == "push"
        )
      ]
      | sort_by([.created_at, .id, .run_attempt])
      | last // empty
    ' <<<"$runs_json")" || fail 'could not select an exact-source Garmin CI run'

    if [[ -z "$matching_run" ]]; then
      printf 'Waiting for Garmin CI run on exact main SHA %s (%s/%s)\n' \
        "$expected_sha" "$poll" "$max_polls"
    else
      local run_sha run_branch run_event run_workflow_id run_attempt run_status run_conclusion run_id
      run_sha="$(jq -r '.head_sha // ""' <<<"$matching_run")"
      run_branch="$(jq -r '.head_branch // ""' <<<"$matching_run")"
      run_event="$(jq -r '.event // ""' <<<"$matching_run")"
      run_workflow_id="$(jq -r '.workflow_id // 0' <<<"$matching_run")"
      run_attempt="$(jq -r '.run_attempt // 0' <<<"$matching_run")"
      run_status="$(jq -r '.status // ""' <<<"$matching_run")"
      run_conclusion="$(jq -r '.conclusion // ""' <<<"$matching_run")"
      run_id="$(jq -r '.id // "unknown"' <<<"$matching_run")"

      [[ "$run_sha" == "$expected_sha" && "$run_branch" == main && "$run_event" == push &&
        "$run_workflow_id" == "$workflow_id" && "$run_attempt" =~ ^[1-9][0-9]*$ ]] ||
        fail "latest Garmin CI run ${run_id} has invalid workflow/source metadata"

      if [[ "$run_status" == completed ]]; then
        [[ "$run_conclusion" == success ]] ||
          fail "latest Garmin CI run ${run_id} attempt ${run_attempt} concluded '${run_conclusion:-unset}'; refusing to publish"
        printf 'Garmin CI run %s attempt %s completed successfully for %s; release may continue.\n' \
          "$run_id" "$run_attempt" "$expected_sha"
        return 0
      fi

      case "$run_status" in
        queued|in_progress|waiting|requested|pending)
          printf 'Garmin CI run %s attempt %s is %s (%s/%s)\n' \
            "$run_id" "$run_attempt" "$run_status" "$poll" "$max_polls"
          ;;
        *)
          fail "latest Garmin CI run ${run_id} has unexpected status '${run_status:-unset}'"
          ;;
      esac
    fi

    if (( poll < max_polls )); then
      sleep 15 || fail 'waiting for the exact-source Garmin CI result was interrupted'
    fi
  done

  fail "no completed successful Garmin CI run for ${expected_sha} within ${max_polls} polls; refusing to publish"
}

case "${1:-}" in
  compile)
    compile_gate
    ;;
  release)
    release_gate
    ;;
  *)
    fail 'usage: scripts/garmin-gate.sh compile|release'
    ;;
esac
