#!/usr/bin/env bash
# PreToolUse hook: block raw package-manager script runners and installs in this repo.
# This repo's toolchain is Vite+ (`vp`); `pnpm run` / `npm run` / `bun run`
# bypass the unified config and can mutate pnpm-lock.yaml. See CLAUDE.md.
#
# Exit code 2 + stderr is fed back to Claude as a blocking error.
# Exits 0 (allow) on parse failure so the hook is never a hard dep.
#
# Note the deliberate gap: `pnpm --filter <pkg> run <script>` is NOT blocked.
# That is the form vite.config.ts's task graph uses internally. Only the bare
# `pnpm run` a human would type by hand is caught.

set -uo pipefail

input=$(cat)
command=$(printf '%s' "$input" | jq -r '.tool_input.command // ""' 2>/dev/null || echo "")

[[ -z "$command" ]] && exit 0

# Token boundary: start-of-string OR whitespace OR shell separator (& | ; ( `)
boundary='(^|[[:space:]&|;()`])'

guidance() {
  cat >&2 <<EOF
Blocked: \`$1\` is forbidden in this repo.

This monorepo's toolchain is Vite+ (\`vp\`). Use the vp equivalent:
  pnpm run check                  -> vp check
  pnpm run lint                   -> vp lint
  pnpm run test                   -> vp test
  pnpm --filter X run typecheck   -> vp run typecheck:<pkg>  (or vp check)
  pnpm run dev                    -> vp run dev
  pnpm install                    -> vp install
  npx / bunx <bin>                -> vp exec <bin>
  npx / bunx <pkg>@<version>      -> vp dlx <pkg>@<version>

Allowed exceptions (no vp wrapper exists):
  pnpm --filter boardsesh-backend run start   (production backend)
  vp exec drizzle-kit generate                (migration generation)

Full command was: $command
EOF
}

# --- pnpm run / npm run / bun run ---
# The regex searches the whole command, so chained commands are checked too.
# `pnpm --filter X run Y` does not match: the runner name and `run` must be
# adjacent.
for runner in pnpm npm bun; do
  if [[ "$command" =~ ${boundary}${runner}[[:space:]]+run([[:space:]]+([^[:space:]&|;()\`]+))? ]]; then
    target="${BASH_REMATCH[3]}"
    guidance "${runner} run${target:+ $target}"
    exit 2
  fi
done

# --- pnpm install ---
# Vite+ resolves the packageManager pin and owns install behavior. A raw install
# can use a different pnpm and mutate the lockfile outside that contract.
if [[ "$command" =~ ${boundary}pnpm[[:space:]]+install([[:space:]]+([^[:space:]\&\|\;\(\)\`]+))? ]]; then
  target="${BASH_REMATCH[3]}"
  guidance "pnpm install${target:+ $target}"
  exit 2
fi

# --- bunx / npx ---
# Legacy Bun is gone from this repo; npx bypasses the pinned toolchain the same way.
# `npx --yes pnpm@<version>` is sanctioned for environments that cannot be
# relied on to honour packageManager.
for runner in bunx npx; do
  remaining="$command"
  while [[ "$remaining" =~ ${boundary}${runner}[[:space:]]+(.*) ]]; do
    rest="${BASH_REMATCH[2]}"
    remaining="$rest"
    if [[ "$runner" == "npx" && "$rest" =~ ^(--yes[[:space:]]+)?pnpm@ ]]; then
      continue
    fi
    guidance "$runner"
    exit 2
  done
done

exit 0
