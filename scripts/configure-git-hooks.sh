#!/bin/sh

# Keep the hook configuration safe for every linked worktree. Git resolves a
# relative hooks path from the current worktree, so .vite-hooks gives each
# worktree its own tracked hooks while sharing the repository config.
set -eu

repo_root=$(git rev-parse --show-toplevel 2>/dev/null) || {
  echo "git hook repair: run this command from inside a Git worktree." >&2
  exit 1
}

cd "$repo_root"

effective_hooks_path=$(git config --get core.hooksPath 2>/dev/null || true)
case "$effective_hooks_path" in
  '' | .vite-hooks/_ | .vite-hooks)
    ;;
  *)
    echo "git hook repair: core.hooksPath is '$effective_hooks_path', not a Boardsesh-managed path." >&2
    echo "Refusing to replace a custom hook path. Move or remove that setting, then rerun setup." >&2
    exit 1
    ;;
esac

# A repeated local key can leave an earlier custom value hidden behind an
# allowed effective value. Refuse that configuration too: setup must never
# discard somebody's hook path as a side effect of repairing this repository.
if ! git config --local --get-all core.hooksPath 2>/dev/null | while IFS= read -r local_configured_path; do
  case "$local_configured_path" in
    '' | .vite-hooks/_ | .vite-hooks)
      ;;
    *)
      echo "git hook repair: local core.hooksPath is '$local_configured_path', not a Boardsesh-managed path." >&2
      echo "Refusing to replace a custom hook path. Move or remove that setting, then rerun setup." >&2
      exit 1
      ;;
  esac
done; then
  exit 1
fi

for required_hook in pre-commit post-checkout commit-msg; do
  hook_path="$repo_root/.vite-hooks/$required_hook"
  if [ ! -x "$hook_path" ]; then
    echo "git hook repair: expected executable hook is missing: $hook_path" >&2
    echo "Run 'vp config' to restore Vite+ hooks, then rerun setup." >&2
    exit 1
  fi
done

if [ ! -x "$repo_root/.githooks/commit-msg" ]; then
  echo "git hook repair: expected executable Conventional Commit hook is missing: $repo_root/.githooks/commit-msg" >&2
  exit 1
fi

git config --local --replace-all core.hooksPath .vite-hooks

local_hooks_path=$(git config --local --get core.hooksPath 2>/dev/null || true)
verified_hooks_path=$(git config --get core.hooksPath 2>/dev/null || true)
if [ "$local_hooks_path" != '.vite-hooks' ] || [ "$verified_hooks_path" != '.vite-hooks' ]; then
  echo "git hook repair: Git did not retain core.hooksPath=.vite-hooks (local='$local_hooks_path', effective='$verified_hooks_path')." >&2
  exit 1
fi

echo "Git hooks ready: core.hooksPath=.vite-hooks"
