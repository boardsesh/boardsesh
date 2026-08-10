#!/usr/bin/env bash
# Read-only proxy for the Sentry API used by sentry-triage.yml.
# The triage agent is only allowlisted to run this script, never bare curl,
# so it cannot reach any other host and never handles the token in its own
# command lines. GET only; the sole option is --with-headers, which dumps
# response headers so the agent can follow Link-header pagination.
set -euo pipefail

path="${1:?usage: sentry-api.sh </api/0/...> [--with-headers]}"
case "$path" in
  /api/0/*) ;;
  *)
    echo "sentry-api.sh: path must start with /api/0/" >&2
    exit 2
    ;;
esac

header_args=()
if [ "${2:-}" = "--with-headers" ]; then
  header_args=(-D -)
elif [ -n "${2:-}" ]; then
  echo "sentry-api.sh: unknown option '${2}'" >&2
  exit 2
fi

exec curl -sS --get "${header_args[@]}" \
  -H "Authorization: Bearer ${SENTRY_TRIAGE_TOKEN:?SENTRY_TRIAGE_TOKEN unset}" \
  "https://us.sentry.io${path}"
