#!/usr/bin/env bash
# Append stdin to the GitHub step summary. The triage agent is allowlisted to
# run this instead of a general-purpose echo, so it has no way to print
# arbitrary strings (e.g. env vars) into logs outside the summary sink.
set -euo pipefail
cat >> "${GITHUB_STEP_SUMMARY:?GITHUB_STEP_SUMMARY unset}"
