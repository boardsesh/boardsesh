#!/bin/sh

# Keep the hook configuration safe for every linked worktree. Git resolves a
# relative hooks path from the current worktree, so .vite-hooks gives each
# worktree its own tracked hooks while sharing the repository config.
set -eu

read_git_config() {
  config_command_output=''
  config_command_status=0
  config_command_output=$(git config "$@" 2>/dev/null) || config_command_status=$?

  case "$config_command_status" in
    0)
      printf '%s' "$config_command_output"
      ;;
    1)
      # Git uses status 1 when a requested key has no value.
      ;;
    *)
      echo "git hook repair: could not read the repository Git configuration." >&2
      return "$config_command_status"
      ;;
  esac
}

repo_root=$(git rev-parse --show-toplevel 2>/dev/null) || {
  echo "git hook repair: run this command from inside a Git worktree." >&2
  exit 1
}

cd "$repo_root"

if ! effective_hooks_path=$(read_git_config --get core.hooksPath); then
  exit 1
fi
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
if ! local_configured_paths=$(read_git_config --local --get-all core.hooksPath); then
  exit 1
fi
if [ -n "$local_configured_paths" ]; then
  while IFS= read -r local_configured_path; do
    case "$local_configured_path" in
      '' | .vite-hooks/_ | .vite-hooks)
        ;;
      *)
        echo "git hook repair: local core.hooksPath is '$local_configured_path', not a Boardsesh-managed path." >&2
        echo "Refusing to replace a custom hook path. Move or remove that setting, then rerun setup." >&2
        exit 1
        ;;
    esac
  done <<EOF
$local_configured_paths
EOF
fi

# A repository can opt into per-worktree config. An allowed Vite+ value there
# overrides the shared local value, so normalize it too; a foreign value remains
# user-owned and is never replaced.
if ! worktree_config_enabled=$(read_git_config --type=bool --get extensions.worktreeConfig); then
  exit 1
fi
worktree_configured_paths=''
if [ "$worktree_config_enabled" = 'true' ]; then
  if ! worktree_configured_paths=$(read_git_config --worktree --get-all core.hooksPath); then
    exit 1
  fi
  if [ -n "$worktree_configured_paths" ]; then
    while IFS= read -r worktree_configured_path; do
      case "$worktree_configured_path" in
        '' | .vite-hooks/_ | .vite-hooks)
          ;;
        *)
          echo "git hook repair: worktree core.hooksPath is '$worktree_configured_path', not a Boardsesh-managed path." >&2
          echo "Refusing to replace a custom hook path. Move or remove that setting, then rerun setup." >&2
          exit 1
          ;;
      esac
    done <<EOF
$worktree_configured_paths
EOF
  fi
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
if [ -n "$worktree_configured_paths" ]; then
  git config --worktree --replace-all core.hooksPath .vite-hooks
fi

if ! local_hooks_path=$(read_git_config --local --get core.hooksPath); then
  exit 1
fi
if ! verified_hooks_path=$(read_git_config --get core.hooksPath); then
  exit 1
fi
if [ "$local_hooks_path" != '.vite-hooks' ] || [ "$verified_hooks_path" != '.vite-hooks' ]; then
  echo "git hook repair: Git did not retain core.hooksPath=.vite-hooks (local='$local_hooks_path', effective='$verified_hooks_path')." >&2
  exit 1
fi

echo "Git hooks ready: core.hooksPath=.vite-hooks"
