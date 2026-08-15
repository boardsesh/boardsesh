#!/usr/bin/env bash
#
# Cleanup inactive git worktrees that have no uncommitted work to preserve.
#
# Eligible worktrees either have a merged PR, or have an open PR whose head is
# exactly in sync with a local HEAD commit that is at least 48 hours old.
#
# Usage:
#   ./cleanup-merged-worktrees.sh           # dry-run: show what would be removed
#   ./cleanup-merged-worktrees.sh --apply   # remove worktrees; preserve open-PR branches

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

# Colors (only when stdout is a TTY).
if [ -t 1 ]; then
  C_RED=$'\033[0;31m'; C_GREEN=$'\033[0;32m'; C_YELLOW=$'\033[0;33m'
  C_BLUE=$'\033[0;34m'; C_DIM=$'\033[2m'; C_RESET=$'\033[0m'
else
  C_RED=''; C_GREEN=''; C_YELLOW=''; C_BLUE=''; C_DIM=''; C_RESET=''
fi

declare -a TO_REMOVE_PATHS=()
declare -a TO_REMOVE_BRANCHES=()
# Non-empty only for open-PR candidates. The OID is used for apply-time
# revalidation and also marks the associated local branch for preservation.
declare -a TO_REMOVE_EXPECTED_HEADS=()

skipped_no_branch=0
skipped_no_pr=0
skipped_open_pr=0
skipped_dirty=0
skipped_unmerged_commits=0
skipped_too_fresh=0
skipped_main=0

# Branches with no PR but no extra content vs main need to be at least this old
# (HEAD commit timestamp) before we'll remove them. 7 days = 604800 seconds.
NO_PR_MIN_AGE_SECONDS=$((7 * 24 * 60 * 60))

# Open PR worktrees are eligible only when their local HEAD exactly matches the
# PR head and the shared commit has been inactive for at least 48 hours.
OPEN_PR_MIN_AGE_SECONDS=$((48 * 60 * 60))

# Resolve the upstream main reference (origin/main, or origin/master as fallback).
# Used to check whether a branch with no PR has any content not already in main.
git_root fetch --quiet origin main 2>/dev/null || git_root fetch --quiet origin master 2>/dev/null || true
UPSTREAM_MAIN=""
if git_root rev-parse --verify --quiet refs/remotes/origin/main >/dev/null; then
  UPSTREAM_MAIN="origin/main"
elif git_root rev-parse --verify --quiet refs/remotes/origin/master >/dev/null; then
  UPSTREAM_MAIN="origin/master"
fi

# Returns 0 (true) if the working tree at $1 is clean.
worktree_clean() {
  local dirty
  dirty=$(git -C "$1" status --porcelain 2>/dev/null) || return 1
  [ -z "$dirty" ]
}

# Returns 0 if HEAD at $1 has no content beyond UPSTREAM_MAIN — either it's an
# ancestor of main, or the trees are identical (squash/rebase scenario).
content_matches_main() {
  local path="$1"
  [ -z "$UPSTREAM_MAIN" ] && return 1
  local local_oid
  local_oid=$(git -C "$path" rev-parse HEAD 2>/dev/null) || return 1
  if git_root merge-base --is-ancestor "$local_oid" "$UPSTREAM_MAIN" 2>/dev/null; then
    return 0
  fi
  git -C "$path" diff --quiet "$UPSTREAM_MAIN" HEAD 2>/dev/null
}

# Echoes the age in seconds of HEAD at $1 (commit timestamp vs. now).
head_age_seconds() {
  local path="$1"
  local commit_ts now_ts
  commit_ts=$(git -C "$path" log -1 --format=%ct HEAD 2>/dev/null) || return 1
  now_ts=$(date +%s)
  echo $((now_ts - commit_ts))
}

# Parse `git worktree list --porcelain` into (path, branch) pairs.
current_path=""
current_branch=""

flush_entry() {
  local path="$1"
  local branch="$2"

  [ -z "$path" ] && return

  # The bare repo has no working tree — nothing to inspect, just skip.
  if [ "$(basename "$path")" = ".bare" ]; then
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

  # Skip the worktree we were invoked from.
  if [ "$path" = "$INVOCATION_PWD" ]; then
    printf "%s» skip%s %s %s(current worktree)%s\n" "$C_DIM" "$C_RESET" "$path" "$C_DIM" "$C_RESET"
    return
  fi

  # Detached HEAD: no branch to query, no PR to look up. Eligible only if the
  # tree matches main, the working dir is clean, and the HEAD commit is at
  # least NO_PR_MIN_AGE_SECONDS old.
  if [ -z "$branch" ]; then
    if ! worktree_clean "$path"; then
      skipped_dirty=$((skipped_dirty + 1))
      printf "%s» keep%s %s %s(detached; uncommitted changes)%s\n" \
        "$C_YELLOW" "$C_RESET" "$path" "$C_YELLOW" "$C_RESET"
      return
    fi
    if ! content_matches_main "$path"; then
      skipped_no_branch=$((skipped_no_branch + 1))
      printf "%s» keep%s %s %s(detached; has content not in %s)%s\n" \
        "$C_YELLOW" "$C_RESET" "$path" "$C_YELLOW" "$UPSTREAM_MAIN" "$C_RESET"
      return
    fi
    local age
    age=$(head_age_seconds "$path") || age=0
    if [ "$age" -lt "$NO_PR_MIN_AGE_SECONDS" ]; then
      skipped_too_fresh=$((skipped_too_fresh + 1))
      printf "%s» keep%s %s %s(detached; tree matches %s but HEAD is %s old)%s\n" \
        "$C_YELLOW" "$C_RESET" "$path" "$C_YELLOW" "$UPSTREAM_MAIN" \
        "$((age / 86400))d" "$C_RESET"
      return
    fi
    TO_REMOVE_PATHS+=("$path")
    TO_REMOVE_BRANCHES+=("")
    TO_REMOVE_EXPECTED_HEADS+=("")
    printf "%s✓ remove%s %s %s(detached; tree matches %s, HEAD %s old)%s\n" \
      "$C_GREEN" "$C_RESET" "$path" "$C_DIM" "$UPSTREAM_MAIN" \
      "$((age / 86400))d" "$C_RESET"
    return
  fi

  # Look up PR(s) for this branch. An OPEN PR takes precedence over a
  # historical MERGED PR because branch names can be reused.
  local pr_json
  pr_json=$(gh pr list --head "$branch" --state all \
    --json number,state,mergedAt,url,headRefOid,mergeCommit 2>/dev/null || echo "[]")

  local merged_pr open_pr
  merged_pr=$(echo "$pr_json" | jq -r '[.[] | select(.state == "MERGED")] | first // empty')
  open_pr=$(echo "$pr_json" | jq -r '[.[] | select(.state == "OPEN")] | first // empty')

  if [ -z "$merged_pr" ] && [ -z "$open_pr" ]; then
    # No PR found by branch name. Fall back to checking whether the branch has
    # any content not already in origin/main — branches often get renamed
    # locally (e.g. `pr-1487` tracking `claude/test-create-climb-form-Dry5Q`)
    # so the head-name lookup misses real merges. The content check catches
    # both squash/rebase merges and renamed-but-merged cases. We additionally
    # require the HEAD commit to be at least NO_PR_MIN_AGE_SECONDS old, since
    # without a PR signal the only confirmation that work is "done" is age.
    if [ -z "$UPSTREAM_MAIN" ]; then
      skipped_no_pr=$((skipped_no_pr + 1))
      printf "%s» skip%s %s [%s] %s(no PR found, no upstream main to compare)%s\n" \
        "$C_DIM" "$C_RESET" "$path" "$branch" "$C_DIM" "$C_RESET"
      return
    fi

    if ! worktree_clean "$path"; then
      skipped_dirty=$((skipped_dirty + 1))
      local dirty file_count
      dirty=$(git -C "$path" status --porcelain 2>/dev/null)
      file_count=$(echo "$dirty" | wc -l | tr -d ' ')
      printf "%s» keep%s %s [%s] %s(no PR; %s uncommitted file(s))%s\n" \
        "$C_YELLOW" "$C_RESET" "$path" "$branch" "$C_YELLOW" "$file_count" "$C_RESET"
      return
    fi

    if ! content_matches_main "$path"; then
      local ahead_count
      ahead_count=$(git -C "$path" rev-list --count "${UPSTREAM_MAIN}..HEAD" 2>/dev/null || echo "?")
      skipped_no_pr=$((skipped_no_pr + 1))
      printf "%s» keep%s %s [%s] %s(no PR; has content not in %s, %s commit(s) ahead)%s\n" \
        "$C_YELLOW" "$C_RESET" "$path" "$branch" "$C_YELLOW" "$UPSTREAM_MAIN" "$ahead_count" "$C_RESET"
      return
    fi

    local age
    age=$(head_age_seconds "$path") || age=0
    if [ "$age" -lt "$NO_PR_MIN_AGE_SECONDS" ]; then
      skipped_too_fresh=$((skipped_too_fresh + 1))
      printf "%s» keep%s %s [%s] %s(no PR; tree matches %s but HEAD is %s old)%s\n" \
        "$C_YELLOW" "$C_RESET" "$path" "$branch" "$C_YELLOW" "$UPSTREAM_MAIN" \
        "$((age / 86400))d" "$C_RESET"
      return
    fi

    TO_REMOVE_PATHS+=("$path")
    TO_REMOVE_BRANCHES+=("$branch")
    TO_REMOVE_EXPECTED_HEADS+=("")
    printf "%s✓ remove%s %s [%s] %s(no PR; tree matches %s, HEAD %s old)%s\n" \
      "$C_GREEN" "$C_RESET" "$path" "$branch" "$C_DIM" "$UPSTREAM_MAIN" \
      "$((age / 86400))d" "$C_RESET"
    return
  fi

  if [ -n "$open_pr" ]; then
    local pr_num pr_url pr_head_oid local_oid dirty age
    pr_num=$(echo "$open_pr" | jq -r '.number')
    pr_url=$(echo "$open_pr" | jq -r '.url')
    pr_head_oid=$(echo "$open_pr" | jq -r '.headRefOid // empty')

    if ! dirty=$(git -C "$path" status --porcelain 2>/dev/null); then
      skipped_open_pr=$((skipped_open_pr + 1))
      printf "%s» skip%s %s [%s] %s(PR #%s OPEN; failed to read status)%s\n" \
        "$C_RED" "$C_RESET" "$path" "$branch" "$C_RED" "$pr_num" "$C_RESET"
      return
    fi

    if [ -n "$dirty" ]; then
      skipped_dirty=$((skipped_dirty + 1))
      local file_count
      file_count=$(echo "$dirty" | wc -l | tr -d ' ')
      printf "%s» keep%s %s [%s] %s(PR #%s OPEN, but %s uncommitted file(s))%s\n" \
        "$C_YELLOW" "$C_RESET" "$path" "$branch" "$C_YELLOW" "$pr_num" "$file_count" "$C_RESET"
      return
    fi

    local_oid=$(git -C "$path" rev-parse HEAD 2>/dev/null || echo "")
    if [ -z "$pr_head_oid" ] || [ -z "$local_oid" ] || [ "$local_oid" != "$pr_head_oid" ]; then
      skipped_open_pr=$((skipped_open_pr + 1))
      printf "%s» keep%s %s [%s] %s(PR #%s OPEN, but local HEAD is not in sync with PR head: %s)%s\n" \
        "$C_YELLOW" "$C_RESET" "$path" "$branch" "$C_YELLOW" "$pr_num" "$pr_url" "$C_RESET"
      return
    fi

    age=$(head_age_seconds "$path") || age=0
    if [ "$age" -lt "$OPEN_PR_MIN_AGE_SECONDS" ]; then
      skipped_too_fresh=$((skipped_too_fresh + 1))
      printf "%s» keep%s %s [%s] %s(PR #%s OPEN and in sync, but HEAD is %sh old)%s\n" \
        "$C_YELLOW" "$C_RESET" "$path" "$branch" "$C_YELLOW" "$pr_num" \
        "$((age / 3600))" "$C_RESET"
      return
    fi

    TO_REMOVE_PATHS+=("$path")
    TO_REMOVE_BRANCHES+=("$branch")
    TO_REMOVE_EXPECTED_HEADS+=("$local_oid")
    printf "%s✓ remove%s %s [%s] %s(PR #%s OPEN and in sync, HEAD %sh old)%s\n" \
      "$C_GREEN" "$C_RESET" "$path" "$branch" "$C_DIM" "$pr_num" \
      "$((age / 3600))" "$C_RESET"
    return
  fi

  local pr_num pr_url pr_head_oid
  pr_num=$(echo "$merged_pr" | jq -r '.number')
  pr_url=$(echo "$merged_pr" | jq -r '.url')
  pr_head_oid=$(echo "$merged_pr" | jq -r '.headRefOid // empty')

  # Check for any uncommitted changes (staged, unstaged, or untracked).
  local dirty
  if ! dirty=$(git -C "$path" status --porcelain 2>/dev/null); then
    printf "%s» skip%s %s %s(failed to read status)%s\n" \
      "$C_RED" "$C_RESET" "$path" "$C_RED" "$C_RESET"
    return
  fi

  if [ -n "$dirty" ]; then
    skipped_dirty=$((skipped_dirty + 1))
    local file_count
    file_count=$(echo "$dirty" | wc -l | tr -d ' ')
    printf "%s» keep%s %s [%s] %s(PR #%s merged, but %s uncommitted file(s))%s\n" \
      "$C_YELLOW" "$C_RESET" "$path" "$branch" "$C_YELLOW" "$pr_num" "$file_count" "$C_RESET"
    return
  fi

  # Check the local branch tip against the PR's head commit. If the local tip is
  # *ahead* of the PR head, there are local commits that were never part of the
  # merged PR — refuse to drop them. If they match, or the local tip is behind,
  # the branch carries no extra work and is safe to remove.
  if [ -n "$pr_head_oid" ]; then
    local local_oid
    local_oid=$(git -C "$path" rev-parse HEAD 2>/dev/null || echo "")
    if [ -n "$local_oid" ] && [ "$local_oid" != "$pr_head_oid" ]; then
      # Is the PR head an ancestor of the local tip? If so, local has extra commits.
      if git_root merge-base --is-ancestor "$pr_head_oid" "$local_oid" 2>/dev/null; then
        skipped_unmerged_commits=$((skipped_unmerged_commits + 1))
        local extra_count
        extra_count=$(git_root rev-list --count "${pr_head_oid}..${local_oid}" 2>/dev/null || echo "?")
        printf "%s» keep%s %s [%s] %s(PR #%s merged, but %s local commit(s) ahead of PR head)%s\n" \
          "$C_YELLOW" "$C_RESET" "$path" "$branch" "$C_YELLOW" "$pr_num" "$extra_count" "$C_RESET"
        return
      fi
      # Otherwise the local tip diverges from the PR head in some other way
      # (different history, e.g. force-pushed or rebased). Be conservative.
      if ! git_root merge-base --is-ancestor "$local_oid" "$pr_head_oid" 2>/dev/null; then
        skipped_unmerged_commits=$((skipped_unmerged_commits + 1))
        printf "%s» keep%s %s [%s] %s(PR #%s merged, but local tip %s diverges from PR head %s)%s\n" \
          "$C_YELLOW" "$C_RESET" "$path" "$branch" "$C_YELLOW" "$pr_num" \
          "${local_oid:0:8}" "${pr_head_oid:0:8}" "$C_RESET"
        return
      fi
    fi
  fi

  TO_REMOVE_PATHS+=("$path")
  TO_REMOVE_BRANCHES+=("$branch")
  TO_REMOVE_EXPECTED_HEADS+=("")
  printf "%s✓ remove%s %s [%s] %s(PR #%s merged)%s\n" \
    "$C_GREEN" "$C_RESET" "$path" "$branch" "$C_DIM" "$pr_num" "$C_RESET"
}

while IFS= read -r line; do
  if [[ "$line" == worktree\ * ]]; then
    flush_entry "$current_path" "$current_branch"
    current_path="${line#worktree }"
    current_branch=""
  elif [[ "$line" == branch\ refs/heads/* ]]; then
    current_branch="${line#branch refs/heads/}"
  fi
done < <(git_root worktree list --porcelain)
flush_entry "$current_path" "$current_branch"

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
echo "─────────────────────────────────────"

if [ "${#TO_REMOVE_PATHS[@]}" -eq 0 ]; then
  echo "Nothing to remove."
  exit 0
fi

if [ "$APPLY" -eq 0 ]; then
  echo
  printf "%sDry run.%s Re-run with %s--apply%s to remove eligible worktrees; open-PR branches are preserved.\n" \
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

  # Open-PR eligibility depends on the worktree still being clean and exactly
  # at the PR head observed during the scan. Fail closed if anything changed
  # before removal so a commit made during this run cannot be discarded.
  if [ -n "$expected_head" ]; then
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
  fi

  if git_root worktree remove "$path"; then
    printf "  %s✓%s removed worktree %s\n" "$C_GREEN" "$C_RESET" "$path"
    if [ -n "$branch" ]; then
      if [ -n "$expected_head" ]; then
        printf "  %s✓%s preserved local branch %s (PR remains open)\n" \
          "$C_GREEN" "$C_RESET" "$branch"
      elif git_root branch -D "$branch" >/dev/null 2>&1; then
        printf "  %s✓%s deleted branch %s\n" "$C_GREEN" "$C_RESET" "$branch"
      else
        printf "  %s!%s could not delete branch %s (may have unmerged commits)\n" "$C_YELLOW" "$C_RESET" "$branch"
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

git_root worktree prune
