#!/usr/bin/env bash
#
# Cleanup inactive git worktrees that have no uncommitted work to preserve.
# Local branches are retained unless a merged worktree is fully represented in
# upstream main. Detached work with unique commits gets a recovery branch.
# Ignored dependency/build artifacts are treated as disposable worktree data.
#
# Usage:
#   ./cleanup-merged-worktrees.sh           # dry-run: show what would be removed
#   ./cleanup-merged-worktrees.sh --apply   # remove worktrees; preserve recovery refs

set -euo pipefail

APPLY=0
for arg in "$@"; do
  case "$arg" in
    --apply) APPLY=1 ;;
    -h|--help)
      sed -n '2,/^$/p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "Unknown argument: $arg" >&2
      exit 2
      ;;
  esac
done

if ! command -v gh >/dev/null; then
  echo "gh CLI not found in PATH" >&2
  exit 1
fi

if ! gh auth status >/dev/null 2>&1; then
  echo "gh CLI is not authenticated. Run: gh auth login" >&2
  exit 1
fi

if ! command -v jq >/dev/null; then
  echo "jq not found in PATH" >&2
  exit 1
fi

# Skip the worktree we were invoked from, just in case it shows up in the list.
INVOCATION_PWD="${PWD_AT_INVOCATION:-$PWD}"

# Resolve which git repo to operate on. The script lives next to a bare repo
# (e.g. /home/developer/projects/boardsesh/.bare) with worktrees as siblings.
# Try the script's directory first, then its `.bare`, then the cwd.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GIT_REPO_ARGS=()
if git -C "$SCRIPT_DIR" worktree list >/dev/null 2>&1; then
  GIT_REPO_ARGS=(-C "$SCRIPT_DIR")
elif [ -d "$SCRIPT_DIR/.bare" ] && git --git-dir="$SCRIPT_DIR/.bare" worktree list >/dev/null 2>&1; then
  GIT_REPO_ARGS=(--git-dir="$SCRIPT_DIR/.bare")
elif git worktree list >/dev/null 2>&1; then
  GIT_REPO_ARGS=()
else
  echo "Could not find a git repo near $SCRIPT_DIR or in $PWD" >&2
  exit 1
fi

git_root() { git "${GIT_REPO_ARGS[@]}" "$@"; }

github_repository_from_origin() {
  local origin_url remote_host remote_path without_scheme
  origin_url=$(git_root remote get-url origin 2>/dev/null) || return 1
  case "$origin_url" in
    git@*:*)
      remote_host="${origin_url#git@}"
      remote_host="${remote_host%%:*}"
      remote_path="${origin_url#*:}"
      ;;
    ssh://git@*/*)
      without_scheme="${origin_url#ssh://git@}"
      remote_host="${without_scheme%%/*}"
      remote_path="${without_scheme#*/}"
      ;;
    http://*|https://*)
      without_scheme="${origin_url#*://}"
      remote_host="${without_scheme%%/*}"
      remote_path="${without_scheme#*/}"
      ;;
    *) return 1 ;;
  esac
  remote_path="${remote_path%.git}"
  [ -n "$remote_host" ] && [ -n "$remote_path" ] || return 1
  if [ "$remote_host" = "github.com" ]; then
    printf '%s\n' "$remote_path"
  else
    printf '%s/%s\n' "$remote_host" "$remote_path"
  fi
}

# Colors (only when stdout is a TTY).
if [ -t 1 ]; then
  C_RED=$'\033[0;31m'; C_GREEN=$'\033[0;32m'; C_YELLOW=$'\033[0;33m'
  C_BLUE=$'\033[0;34m'; C_DIM=$'\033[2m'; C_RESET=$'\033[0m'
else
  C_RED=''; C_GREEN=''; C_YELLOW=''; C_BLUE=''; C_DIM=''; C_RESET=''
fi

declare -a TO_REMOVE_PATHS=()
declare -a TO_REMOVE_BRANCHES=()
declare -a TO_REMOVE_EXPECTED_HEADS=()
declare -a TO_REMOVE_BRANCH_ACTIONS=()
declare -a TO_REMOVE_MIN_INACTIVE_SECONDS=()

skipped_no_branch=0
skipped_no_pr=0
skipped_open_pr=0
skipped_dirty=0
skipped_unmerged_commits=0
skipped_too_fresh=0
skipped_main=0
skipped_in_use=0
skipped_locked=0
PROCESS_CWD_WARNING_SHOWN=0
PROCESS_CWD_PROC_ROOT="${WORKTREE_CWD_PROC_ROOT_OVERRIDE:-/proc}"
PROCESS_CWD_SNAPSHOT_READY=0
PROCESS_CWD_SNAPSHOT_TRUSTED=0
declare -a PROCESS_CWD_SNAPSHOT=()

# Every removal has an inactivity floor. Agent worktrees are intentionally
# shorter-lived because a live process CWD is checked both during the scan and
# immediately before removal.
MERGED_MIN_INACTIVE_SECONDS=$((24 * 60 * 60))
OPEN_PR_MIN_INACTIVE_SECONDS=$((48 * 60 * 60))
NO_PR_MIN_INACTIVE_SECONDS=$((7 * 24 * 60 * 60))
AGENT_MIN_INACTIVE_SECONDS=$((48 * 60 * 60))

# Resolve a freshly fetched upstream main reference. A stale remote-tracking ref
# is never used to justify deleting a branch or omitting detached recovery.
UPSTREAM_MAIN=""
if git_root fetch --quiet origin main 2>/dev/null \
   && git_root rev-parse --verify --quiet refs/remotes/origin/main >/dev/null; then
  UPSTREAM_MAIN="origin/main"
elif git_root fetch --quiet origin master 2>/dev/null \
     && git_root rev-parse --verify --quiet refs/remotes/origin/master >/dev/null; then
  UPSTREAM_MAIN="origin/master"
else
  echo "Warning: upstream main could not be refreshed; all local refs will be preserved" >&2
fi

# Fetch only the newest PR metadata once. Older unmatched PR branches follow
# the more conservative no-PR policy: seven days of inactivity and no ref
# deletion. This avoids downloading the repository's full PR history.
GITHUB_REPOSITORY="${GITHUB_REPOSITORY_OVERRIDE:-}"
if [ -z "$GITHUB_REPOSITORY" ]; then
  GITHUB_REPOSITORY=$(github_repository_from_origin) || {
    echo "Could not derive a GitHub repository from the selected repo's origin" >&2
    exit 1
  }
fi
PR_METADATA_LIMIT=1000
if ! ALL_PR_JSON=$(gh pr list --repo "$GITHUB_REPOSITORY" --state all --limit "$PR_METADATA_LIMIT" \
  --json number,state,createdAt,mergedAt,url,headRefName,headRefOid,mergeCommit,isCrossRepository); then
  echo "Could not load GitHub PR metadata; no worktrees were changed" >&2
  exit 1
fi
if ! jq -e 'type == "array"' >/dev/null 2>&1 <<<"$ALL_PR_JSON"; then
  echo "GitHub PR metadata was not a valid JSON array; no worktrees were changed" >&2
  exit 1
fi
PR_METADATA_COUNT=$(jq 'length' <<<"$ALL_PR_JSON")
if [ "$PR_METADATA_COUNT" -ge "$PR_METADATA_LIMIT" ]; then
  echo "Warning: only the newest $PR_METADATA_LIMIT PRs were loaded; older unmatched branches will use the conservative no-PR policy" >&2
fi

# Returns 0 (true) if the working tree at $1 is clean.
worktree_clean() {
  local dirty
  dirty=$(git -C "$1" status --porcelain 2>/dev/null) || return 1
  [ -z "$dirty" ]
}

# Returns 0 when Git has explicitly locked this worktree. Treat a failure to
# resolve its administrative lock path as locked so cleanup fails closed.
worktree_locked() {
  local path="$1"
  local lock_path
  lock_path=$(git -C "$path" rev-parse --path-format=absolute --git-path locked 2>/dev/null) || return 0
  [ -e "$lock_path" ]
}

canonical_directory() {
  (cd "$1" 2>/dev/null && pwd -P)
}

# Returns 0 when $2 is $1 or is nested below it.
path_contains() {
  local root_path="$1"
  local possible_child="$2"
  [ "$possible_child" = "$root_path" ] || [[ "$possible_child" == "$root_path"/* ]]
}

# Returns 0 if any live process has its CWD at or below this worktree. On
# systems without /proc, use lsof. If neither mechanism is available, fail
# closed and report the worktree as in use.
warn_process_cwd_scan_unavailable() {
  if [ "$PROCESS_CWD_WARNING_SHOWN" -eq 0 ]; then
    echo "Warning: live process CWDs could not be enumerated; affected worktrees will be preserved" >&2
    PROCESS_CWD_WARNING_SHOWN=1
  fi
}

refresh_process_cwd_snapshot() {
  local process_cwd cwd_link lsof_output
  PROCESS_CWD_SNAPSHOT=()
  PROCESS_CWD_SNAPSHOT_READY=1
  PROCESS_CWD_SNAPSHOT_TRUSTED=0
  if [ -d "$PROCESS_CWD_PROC_ROOT" ] \
     && readlink "$PROCESS_CWD_PROC_ROOT/self/cwd" >/dev/null 2>&1; then
    for cwd_link in "$PROCESS_CWD_PROC_ROOT"/[0-9]*/cwd; do
      process_cwd=$(readlink "$cwd_link" 2>/dev/null) || continue
      process_cwd="${process_cwd% (deleted)}"
      PROCESS_CWD_SNAPSHOT+=("$process_cwd")
    done
    PROCESS_CWD_SNAPSHOT_TRUSTED=1
    return 0
  fi

  if command -v lsof >/dev/null 2>&1; then
    if ! lsof_output=$(lsof -a -d cwd -Fn 2>/dev/null); then
      warn_process_cwd_scan_unavailable
      return 1
    fi
    while IFS= read -r process_cwd; do
      [[ "$process_cwd" == n* ]] || continue
      process_cwd="${process_cwd#n}"
      process_cwd="${process_cwd% (deleted)}"
      PROCESS_CWD_SNAPSHOT+=("$process_cwd")
    done <<<"$lsof_output"
    PROCESS_CWD_SNAPSHOT_TRUSTED=1
    return 0
  fi

  warn_process_cwd_scan_unavailable
  return 1
}

worktree_in_use() {
  local path="$1"
  local canonical_path process_cwd
  canonical_path=$(canonical_directory "$path") || return 0
  if [ "$PROCESS_CWD_SNAPSHOT_READY" -eq 0 ]; then
    refresh_process_cwd_snapshot || return 0
  fi
  [ "$PROCESS_CWD_SNAPSHOT_TRUSTED" -eq 1 ] || return 0
  for process_cwd in "${PROCESS_CWD_SNAPSHOT[@]}"; do
    if path_contains "$canonical_path" "$process_cwd"; then
      return 0
    fi
  done
  return 1
}

# Returns 0 if HEAD at $1 has no content beyond UPSTREAM_MAIN — either it's an
# ancestor of main, or the trees are identical (squash/rebase scenario).
content_matches_main() {
  local path="$1"
  [ -z "$UPSTREAM_MAIN" ] && return 1
  local local_oid
  local_oid=$(git -C "$path" rev-parse HEAD 2>/dev/null) || return 1
  content_oid_matches_main "$local_oid"
}

content_oid_matches_main() {
  local local_oid="$1"
  [ -z "$UPSTREAM_MAIN" ] && return 1
  if git_root merge-base --is-ancestor "$local_oid" "$UPSTREAM_MAIN" 2>/dev/null; then
    return 0
  fi
  git_root diff --no-ext-diff --quiet "$UPSTREAM_MAIN" "$local_oid" 2>/dev/null
}

oid_reachable_from_main() {
  local local_oid="$1"
  [ -n "$UPSTREAM_MAIN" ] \
    && git_root merge-base --is-ancestor "$local_oid" "$UPSTREAM_MAIN" 2>/dev/null
}

# Echoes the number of seconds since this worktree's administrative HEAD or
# attached branch ref was touched. Worktree-prune operations can rewrite every
# HEAD reflog at once, so reflog mtimes are not an activity signal.
worktree_inactivity_seconds() {
  local path="$1"
  local head_path branch_ref branch_ref_path latest_ts file_ts commit_ts now_ts activity_path
  head_path=$(git -C "$path" rev-parse --path-format=absolute --git-path HEAD 2>/dev/null || echo "")
  branch_ref=$(git -C "$path" symbolic-ref --quiet HEAD 2>/dev/null || echo "")
  branch_ref_path=""
  if [ -n "$branch_ref" ]; then
    branch_ref_path=$(git -C "$path" rev-parse --path-format=absolute --git-path "$branch_ref" 2>/dev/null || echo "")
  fi
  latest_ts=0
  for activity_path in "$head_path" "$branch_ref_path"; do
    [ -f "$activity_path" ] || continue
    file_ts=$(stat -c %Y "$activity_path" 2>/dev/null || stat -f %m "$activity_path" 2>/dev/null || echo 0)
    if [ "$file_ts" -gt "$latest_ts" ]; then
      latest_ts="$file_ts"
    fi
  done
  commit_ts=$(git -C "$path" log -1 --format=%ct HEAD 2>/dev/null) || return 1
  if [ "$commit_ts" -gt "$latest_ts" ]; then
    latest_ts="$commit_ts"
  fi
  now_ts=$(date +%s)
  echo $((now_ts - latest_ts))
}

minimum_inactivity_seconds() {
  local path="$1"
  local pr_state="$2"
  if [[ "$path" == */.claude/worktrees/* ]]; then
    echo "$AGENT_MIN_INACTIVE_SECONDS"
  elif [ "$pr_state" = "MERGED" ]; then
    echo "$MERGED_MIN_INACTIVE_SECONDS"
  elif [ "$pr_state" = "OPEN" ]; then
    echo "$OPEN_PR_MIN_INACTIVE_SECONDS"
  else
    echo "$NO_PR_MIN_INACTIVE_SECONDS"
  fi
}

format_inactivity() {
  local inactivity="$1"
  if [ "$inactivity" -ge 86400 ] || [ "$inactivity" -le -86400 ]; then
    echo "$((inactivity / 86400))d"
  else
    echo "$((inactivity / 3600))h"
  fi
}

queue_removal() {
  local path="$1"
  local branch="$2"
  local branch_action="$3"
  local minimum_inactivity="$4"
  local reason="$5"
  local expected_head="${6:-}"
  if [ -z "$expected_head" ]; then
    expected_head=$(git -C "$path" rev-parse HEAD 2>/dev/null || echo "")
  fi
  if [ -z "$expected_head" ]; then
    printf "%s» skip%s %s %s(failed to read HEAD)%s\n" \
      "$C_RED" "$C_RESET" "$path" "$C_RED" "$C_RESET"
    return
  fi
  TO_REMOVE_PATHS+=("$path")
  TO_REMOVE_BRANCHES+=("$branch")
  TO_REMOVE_EXPECTED_HEADS+=("$expected_head")
  TO_REMOVE_BRANCH_ACTIONS+=("$branch_action")
  TO_REMOVE_MIN_INACTIVE_SECONDS+=("$minimum_inactivity")
  printf "%s✓ remove%s %s%s %s(%s)%s\n" \
    "$C_GREEN" "$C_RESET" "$path" "${branch:+ [$branch]}" "$C_DIM" "$reason" "$C_RESET"
}

# Parse `git worktree list --porcelain` into (path, branch) pairs.
current_path=""
current_branch=""
current_bare=0

flush_entry() {
  local path="$1"
  local branch="$2"
  local is_bare="${3:-0}"

  [ -z "$path" ] && return

  # The bare repo has no working tree — nothing to inspect, just skip.
  if [ "$is_bare" = 1 ] || [ "$(basename "$path")" = ".bare" ]; then
    skipped_no_branch=$((skipped_no_branch + 1))
    printf "%s» skip%s %s %s(bare repo)%s\n" "$C_DIM" "$C_RESET" "$path" "$C_DIM" "$C_RESET"
    return
  fi
  # Never touch the "main" worktree — it's the canonical starting point for new work.
  # Match by branch name AND by directory basename so it stays protected even if the
  # tracked branch is ever renamed.
  if [ "$branch" = "main" ] || [ "$branch" = "master" ] \
     || [ "$(basename "$path")" = "main" ] || [ "$(basename "$path")" = "master" ]; then
    skipped_main=$((skipped_main + 1))
    printf "%s» skip%s %s %s(main worktree — always preserved)%s\n" "$C_DIM" "$C_RESET" "$path" "$C_DIM" "$C_RESET"
    return
  fi

  # Skip the worktree we were invoked from, including invocation from one of
  # its subdirectories.
  local canonical_path canonical_invocation
  canonical_path=$(canonical_directory "$path" || echo "$path")
  canonical_invocation=$(canonical_directory "$INVOCATION_PWD" || echo "$INVOCATION_PWD")
  if path_contains "$canonical_path" "$canonical_invocation"; then
    printf "%s» skip%s %s %s(current worktree)%s\n" "$C_DIM" "$C_RESET" "$path" "$C_DIM" "$C_RESET"
    return
  fi

  local dirty
  if ! dirty=$(git -C "$path" status --porcelain 2>/dev/null); then
    printf "%s» skip%s %s %s(failed to read status)%s\n" \
      "$C_RED" "$C_RESET" "$path" "$C_RED" "$C_RESET"
    return
  fi

  if worktree_in_use "$path"; then
    skipped_in_use=$((skipped_in_use + 1))
    printf "%s» keep%s %s %s(a live process has its CWD in this worktree)%s\n" \
      "$C_YELLOW" "$C_RESET" "$path" "$C_YELLOW" "$C_RESET"
    return
  fi
  if worktree_locked "$path"; then
    skipped_locked=$((skipped_locked + 1))
    printf "%s» keep%s %s %s(worktree is locked)%s\n" \
      "$C_YELLOW" "$C_RESET" "$path" "$C_YELLOW" "$C_RESET"
    return
  fi
  if [ -n "$dirty" ]; then
    skipped_dirty=$((skipped_dirty + 1))
    local file_count
    file_count=$(echo "$dirty" | wc -l | tr -d ' ')
    printf "%s» keep%s %s%s %s(%s uncommitted file(s))%s\n" \
      "$C_YELLOW" "$C_RESET" "$path" "${branch:+ [$branch]}" \
      "$C_YELLOW" "$file_count" "$C_RESET"
    return
  fi

  # A stale detached worktree is removable even when it has unique content:
  # apply mode creates a recovery branch before removing it.
  if [ -z "$branch" ]; then
    local minimum_inactivity inactivity inactivity_label branch_action reason
    minimum_inactivity=$(minimum_inactivity_seconds "$path" "NONE")
    inactivity=$(worktree_inactivity_seconds "$path") || inactivity=0
    inactivity_label=$(format_inactivity "$inactivity")
    if [ "$inactivity" -lt "$minimum_inactivity" ]; then
      skipped_too_fresh=$((skipped_too_fresh + 1))
      printf "%s» keep%s %s %s(detached; inactive for %s, minimum is %s)%s\n" \
        "$C_YELLOW" "$C_RESET" "$path" "$C_YELLOW" "$inactivity_label" \
        "$(format_inactivity "$minimum_inactivity")" "$C_RESET"
      return
    fi
    local detached_oid
    detached_oid=$(git -C "$path" rev-parse HEAD 2>/dev/null || echo "")
    if oid_reachable_from_main "$detached_oid"; then
      branch_action="none"
      reason="detached; commit is reachable from ${UPSTREAM_MAIN}; inactive ${inactivity_label}"
    else
      branch_action="recover-detached"
      reason="detached; unique content will get a recovery branch; inactive ${inactivity_label}"
    fi
    queue_removal "$path" "" "$branch_action" "$minimum_inactivity" "$reason"
    return
  fi

  # Look up PR(s) for this branch. An OPEN PR takes precedence over a
  # historical MERGED PR unless a PR head exactly matches this checkout. The
  # OID match disambiguates reused branch names and same-named fork branches.
  local pr_json local_oid
  local_oid=$(git -C "$path" rev-parse HEAD 2>/dev/null || echo "")
  pr_json=$(echo "$ALL_PR_JSON" | jq -c --arg branch "$branch" \
    '[.[] | select(.headRefName == $branch)]')

  local exact_head_pr open_pr latest_non_open_pr
  exact_head_pr=$(echo "$pr_json" | jq -r --arg oid "$local_oid" \
    '[.[] | select(.headRefOid == $oid)] | max_by(.createdAt) // empty')
  open_pr=$(echo "$pr_json" | jq -r \
    '[.[] | select(.state == "OPEN" and .isCrossRepository == false)] | max_by(.createdAt) // empty')
  latest_non_open_pr=$(echo "$pr_json" | jq -r \
    '[.[] | select((.state == "MERGED" or .state == "CLOSED") and .isCrossRepository == false)] | max_by(.createdAt) // empty')

  local pr_state selected_pr
  if [ -n "$exact_head_pr" ]; then
    pr_state=$(echo "$exact_head_pr" | jq -r '.state')
    selected_pr="$exact_head_pr"
  elif [ -n "$open_pr" ]; then
    pr_state="OPEN"
    selected_pr="$open_pr"
  elif [ -n "$latest_non_open_pr" ]; then
    pr_state=$(echo "$latest_non_open_pr" | jq -r '.state')
    selected_pr="$latest_non_open_pr"
  else
    pr_state="NONE"
    selected_pr=""
  fi

  local minimum_inactivity inactivity inactivity_label
  minimum_inactivity=$(minimum_inactivity_seconds "$path" "$pr_state")
  inactivity=$(worktree_inactivity_seconds "$path") || inactivity=0
  inactivity_label=$(format_inactivity "$inactivity")
  if [ "$inactivity" -lt "$minimum_inactivity" ]; then
    skipped_too_fresh=$((skipped_too_fresh + 1))
    printf "%s» keep%s %s [%s] %s(%s; inactive for %s, minimum is %s)%s\n" \
      "$C_YELLOW" "$C_RESET" "$path" "$branch" "$C_YELLOW" \
      "${pr_state/NONE/no PR}" "$inactivity_label" \
      "$(format_inactivity "$minimum_inactivity")" "$C_RESET"
    return
  fi

  local pr_num pr_head_oid branch_action reason
  branch_action="preserve"
  case "$pr_state" in
    NONE)
      if content_matches_main "$path"; then
        reason="no PR; content is in ${UPSTREAM_MAIN}; preserving branch; inactive ${inactivity_label}"
      else
        reason="no PR; unique content; preserving branch; inactive ${inactivity_label}"
      fi
      ;;
    CLOSED)
      pr_num=$(echo "$selected_pr" | jq -r '.number')
      reason="PR #${pr_num} closed without merge; preserving branch; inactive ${inactivity_label}"
      ;;
    OPEN)
      pr_num=$(echo "$selected_pr" | jq -r '.number')
      pr_head_oid=$(echo "$selected_pr" | jq -r '.headRefOid // empty')
      if [ -n "$pr_head_oid" ] && [ "$local_oid" = "$pr_head_oid" ]; then
        reason="PR #${pr_num} OPEN and in sync; preserving branch; inactive ${inactivity_label}"
      else
        reason="PR #${pr_num} OPEN with a different local tip; preserving branch; inactive ${inactivity_label}"
      fi
      ;;
    MERGED)
      pr_num=$(echo "$selected_pr" | jq -r '.number')
      pr_head_oid=$(echo "$selected_pr" | jq -r '.headRefOid // empty')
      reason="PR #${pr_num} merged; inactive ${inactivity_label}"

      # Deleting the local branch is only useful when both its history/content
      # are already represented in main and it has not diverged from the PR.
      # Claude agent branches are always retained because their worktrees are
      # collected on the shorter inactivity schedule.
      if [[ "$path" != */.claude/worktrees/* ]] \
         && content_matches_main "$path" \
         && { [ -z "$pr_head_oid" ] || [ "$local_oid" = "$pr_head_oid" ] \
              || git_root merge-base --is-ancestor "$local_oid" "$pr_head_oid" 2>/dev/null; }; then
        branch_action="delete"
      else
        reason="${reason}; preserving branch with unique or divergent content"
      fi
      ;;
  esac

  queue_removal "$path" "$branch" "$branch_action" "$minimum_inactivity" "$reason" "$local_oid"
}

while IFS= read -r line; do
  if [[ "$line" == worktree\ * ]]; then
    flush_entry "$current_path" "$current_branch" "$current_bare"
    current_path="${line#worktree }"
    current_branch=""
    current_bare=0
  elif [[ "$line" == branch\ refs/heads/* ]]; then
    current_branch="${line#branch refs/heads/}"
  elif [ "$line" = "bare" ]; then
    current_bare=1
  fi
done < <(git_root worktree list --porcelain)
flush_entry "$current_path" "$current_branch" "$current_bare"

echo
echo "─────────────────────────────────────"
printf "Eligible for removal: %s%d%s\n" "$C_GREEN" "${#TO_REMOVE_PATHS[@]}" "$C_RESET"
printf "Skipped — open PR:    %d\n" "$skipped_open_pr"
printf "Skipped — no PR:      %d\n" "$skipped_no_pr"
printf "Skipped — dirty:      %s%d%s\n" "$C_YELLOW" "$skipped_dirty" "$C_RESET"
printf "Skipped — extra commits: %s%d%s\n" "$C_YELLOW" "$skipped_unmerged_commits" "$C_RESET"
printf "Skipped — too fresh:  %s%d%s\n" "$C_YELLOW" "$skipped_too_fresh" "$C_RESET"
printf "Skipped — main:       %d\n" "$skipped_main"
printf "Skipped — detached:   %d\n" "$skipped_no_branch"
printf "Skipped — in use:      %s%d%s\n" "$C_YELLOW" "$skipped_in_use" "$C_RESET"
printf "Skipped — locked:      %s%d%s\n" "$C_YELLOW" "$skipped_locked" "$C_RESET"
echo "─────────────────────────────────────"

if [ "${#TO_REMOVE_PATHS[@]}" -eq 0 ]; then
  echo "Nothing to remove."
  exit 0
fi

if [ "$APPLY" -eq 0 ]; then
  echo
  printf "%sDry run.%s Re-run with %s--apply%s to remove eligible worktrees; recovery refs are preserved.\n" \
    "$C_BLUE" "$C_RESET" "$C_BLUE" "$C_RESET"
  exit 0
fi

echo
echo "Removing worktrees..."
removed=0
failed=0
skipped_during_apply=0
for i in "${!TO_REMOVE_PATHS[@]}"; do
  path="${TO_REMOVE_PATHS[$i]}"
  branch="${TO_REMOVE_BRANCHES[$i]}"
  expected_head="${TO_REMOVE_EXPECTED_HEADS[$i]}"
  branch_action="${TO_REMOVE_BRANCH_ACTIONS[$i]}"
  minimum_inactivity="${TO_REMOVE_MIN_INACTIVE_SECONDS[$i]}"

  # Every candidate is revalidated. This is deliberately redundant with the
  # scan because a process, edit, commit, or checkout can happen while GitHub
  # metadata is being inspected.
  if worktree_locked "$path"; then
    printf "  %s!%s skipped %s (worktree is locked)\n" \
      "$C_YELLOW" "$C_RESET" "$path"
    skipped_during_apply=$((skipped_during_apply + 1))
    continue
  fi
  if ! worktree_clean "$path"; then
    printf "  %s!%s skipped %s (worktree changed after eligibility scan)\n" \
      "$C_YELLOW" "$C_RESET" "$path"
    skipped_during_apply=$((skipped_during_apply + 1))
    continue
  fi
  current_head=$(git -C "$path" rev-parse HEAD 2>/dev/null || echo "")
  if [ "$current_head" != "$expected_head" ]; then
    printf "  %s!%s skipped %s (worktree changed after eligibility scan)\n" \
      "$C_YELLOW" "$C_RESET" "$path"
    skipped_during_apply=$((skipped_during_apply + 1))
    continue
  fi
  current_branch=$(git -C "$path" symbolic-ref --quiet --short HEAD 2>/dev/null || echo "")
  if [ "$current_branch" != "$branch" ]; then
    printf "  %s!%s skipped %s (checkout changed after eligibility scan)\n" \
      "$C_YELLOW" "$C_RESET" "$path"
    skipped_during_apply=$((skipped_during_apply + 1))
    continue
  fi
  current_inactivity=$(worktree_inactivity_seconds "$path" || echo 0)
  if [ "$current_inactivity" -lt "$minimum_inactivity" ]; then
    printf "  %s!%s skipped %s (worktree became active after eligibility scan)\n" \
      "$C_YELLOW" "$C_RESET" "$path"
    skipped_during_apply=$((skipped_during_apply + 1))
    continue
  fi

  recovery_branch=""
  if [ "$branch_action" = "recover-detached" ]; then
    recovery_path=$(canonical_directory "$path" || printf '%s' "$path")
    recovery_path_hash=$(printf '%s' "$recovery_path" | git_root hash-object --stdin)
    recovery_slug_source="$(basename "$path")-$(basename "$(dirname "$path")")"
    recovery_slug=$(printf '%s' "$recovery_slug_source" | tr -cs 'A-Za-z0-9._-' '-')
    recovery_slug="${recovery_slug#-}"
    recovery_slug="${recovery_slug%-}"
    recovery_base="recovery/worktree-${recovery_slug:-detached}-${recovery_path_hash:0:10}-${current_head:0:12}"
    recovery_branch="$recovery_base"
    recovery_suffix=1
    while git_root show-ref --verify --quiet "refs/heads/$recovery_branch"; do
      recovery_oid=$(git_root rev-parse "refs/heads/$recovery_branch" 2>/dev/null || echo "")
      if [ "$recovery_oid" = "$current_head" ]; then
        break
      fi
      recovery_branch="${recovery_base}-${recovery_suffix}"
      recovery_suffix=$((recovery_suffix + 1))
    done
    if ! git_root show-ref --verify --quiet "refs/heads/$recovery_branch"; then
      if ! git_root branch "$recovery_branch" "$current_head"; then
        printf "  %s!%s skipped %s (could not create detached recovery branch)\n" \
          "$C_YELLOW" "$C_RESET" "$path"
        skipped_during_apply=$((skipped_during_apply + 1))
        continue
      fi
    fi
    printf "  %s✓%s preserved detached HEAD as %s\n" \
      "$C_GREEN" "$C_RESET" "$recovery_branch"
  fi

  # Repeat every volatile check as close as possible to the destructive
  # operation. The earlier revalidation can itself take time on a large repo.
  final_head=$(git -C "$path" rev-parse HEAD 2>/dev/null || echo "")
  final_branch=$(git -C "$path" symbolic-ref --quiet --short HEAD 2>/dev/null || echo "")
  final_inactivity=$(worktree_inactivity_seconds "$path" || echo 0)
  if ! refresh_process_cwd_snapshot; then
    : # An untrusted snapshot makes worktree_in_use fail closed below.
  fi
  if worktree_in_use "$path" || worktree_locked "$path" || ! worktree_clean "$path" \
     || [ "$final_head" != "$expected_head" ] || [ "$final_branch" != "$branch" ] \
     || [ "$final_inactivity" -lt "$minimum_inactivity" ]; then
    printf "  %s!%s skipped %s (worktree changed or became in use before removal)\n" \
      "$C_YELLOW" "$C_RESET" "$path"
    skipped_during_apply=$((skipped_during_apply + 1))
    continue
  fi

  if git_root worktree remove "$path"; then
    printf "  %s✓%s removed worktree %s\n" "$C_GREEN" "$C_RESET" "$path"
    if [ -n "$branch" ]; then
      branch_head=$(git_root rev-parse "refs/heads/$branch" 2>/dev/null || echo "")
      if [ "$branch_action" = "delete" ] && [ "$branch_head" = "$expected_head" ] \
         && content_oid_matches_main "$branch_head" \
         && git_root branch -D "$branch" >/dev/null 2>&1; then
        printf "  %s✓%s deleted branch %s\n" "$C_GREEN" "$C_RESET" "$branch"
      elif [ "$branch_action" = "delete" ]; then
        printf "  %s!%s could not delete branch %s (worktree was removed; branch retained)\n" \
          "$C_YELLOW" "$C_RESET" "$branch"
      else
        printf "  %s✓%s preserved local branch %s\n" "$C_GREEN" "$C_RESET" "$branch"
      fi
    fi
    removed=$((removed + 1))
  else
    printf "  %s✗%s failed to remove %s\n" "$C_RED" "$C_RESET" "$path"
    failed=$((failed + 1))
  fi
done

echo
printf "Done. Removed: %s%d%s   Failed: %s%d%s   Skipped after scan: %s%d%s\n" \
  "$C_GREEN" "$removed" "$C_RESET" "$C_RED" "$failed" "$C_RESET" \
  "$C_YELLOW" "$skipped_during_apply" "$C_RESET"
