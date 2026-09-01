#!/usr/bin/env bash
# ACTIONS_RUNNER_HOOK_JOB_STARTED -- runs before the job's first step.
#
# Points a fresh workspace at the git object store baked into this image, so
# `actions/checkout` does an incremental fetch of the PR's commits instead of
# a cold ~400 MB clone. Without this the baked history is inert and only the
# pnpm half of the seed pays off.
#
# How it survives checkout: `actions/checkout` defaults to `clean: true`,
# which is `git clean -ffdx` INSIDE the repo -- it never removes `.git`
# itself. So an existing `.git` with the right remote is honoured (checkout
# fetches into it) while anything seeded next to it in the workspace would be
# swept away. The alternate itself lives outside the workspace entirely.
#
# BEST-EFFORT BY DESIGN. A hook that exits non-zero fails the job before it
# starts, and this is an optimisation: every branch below falls through to
# `exit 0`, leaving checkout to do the cold clone it would have done anyway.
# The cost of being wrong here is a slow job, never a failed one.

set -uo pipefail

log() { echo "[job-started] $*"; }

seed_git_dir="${CI_SEED_GIT_DIR:-/ci-seed/git}"

if [ ! -d "${seed_git_dir}/objects" ]; then
  log "no seeded object store at ${seed_git_dir}; leaving checkout to clone"
  exit 0
fi

if [ -z "${GITHUB_WORKSPACE:-}" ] || [ ! -d "${GITHUB_WORKSPACE}" ]; then
  log "no GITHUB_WORKSPACE; nothing to seed"
  exit 0
fi

# The seed holds one repository's objects. Pointing another repository's
# checkout at it would not corrupt anything (alternates are read-only extra
# object sources) but it would be pure overhead, so only seed the match.
seed_repo="${CI_SEED_REPOSITORY:-boardsesh/boardsesh}"
if [ "${GITHUB_REPOSITORY:-}" != "${seed_repo}" ]; then
  log "job is for ${GITHUB_REPOSITORY:-<unset>}, seed is for ${seed_repo}; skipping"
  exit 0
fi

# A workspace that already has a repo is not ours to rewrite -- the runner
# reuses workspaces within a job, and re-initialising underneath a checkout
# that already ran would be destructive.
if [ -e "${GITHUB_WORKSPACE}/.git" ]; then
  log "workspace already has .git; leaving it alone"
  exit 0
fi

if ! git init --quiet "${GITHUB_WORKSPACE}" 2>/dev/null; then
  log "git init failed; leaving checkout to clone"
  exit 0
fi

# checkout compares this against the repository it was asked for and re-clones
# from scratch if it disagrees, so a wrong URL costs a slow job, not a broken
# one.
server_url="${GITHUB_SERVER_URL:-https://github.com}"
if ! git -C "${GITHUB_WORKSPACE}" remote add origin \
     "${server_url}/${GITHUB_REPOSITORY}" 2>/dev/null; then
  log "could not set origin; removing the partial repo"
  rm -rf -- "${GITHUB_WORKSPACE}/.git"
  exit 0
fi

# The alternate is the whole trick: an extra READ-ONLY object source. Git
# resolves objects from it but writes new ones into the workspace's own
# object directory, so a job physically cannot mutate the seed even before
# `--rm` discards the container.
alternates_file="${GITHUB_WORKSPACE}/.git/objects/info/alternates"
mkdir -p "$(dirname "${alternates_file}")"
if ! printf '%s\n' "${seed_git_dir}/objects" > "${alternates_file}"; then
  log "could not write alternates; removing the partial repo"
  rm -rf -- "${GITHUB_WORKSPACE}/.git"
  exit 0
fi

# Copy the seed's refs across. THIS IS THE HALF THAT ACTUALLY SAVES THE
# DOWNLOAD, and it is easy to leave out because the alternate alone looks
# like it should be enough. It is not: `git fetch` negotiation is driven by
# the fetching repo's refs, so a workspace with every object but no refs tells
# the server "I have nothing" and receives a full pack anyway. Naming the
# seeded tips is what lets the fetch resolve to a delta.
seeded_refs=0
while read -r object_id ref_name; do
  [ -n "${object_id}" ] || continue
  # update-ref refuses an object it cannot resolve, so this doubles as the
  # proof that the alternate is really wired up.
  if git -C "${GITHUB_WORKSPACE}" update-ref "${ref_name}" "${object_id}" 2>/dev/null; then
    seeded_refs=$((seeded_refs + 1))
  fi
done <<EOF
$(git --git-dir="${seed_git_dir}" for-each-ref --format='%(objectname) %(refname)' 'refs/ci-seed/*' 2>/dev/null)
EOF

if [ "${seeded_refs}" -eq 0 ]; then
  # Either the seed carries no refs or the alternate does not resolve them.
  # Both mean a fetch would negotiate from nothing, so the seeded repo buys
  # nothing and only risks confusing checkout. Hand it a clean slate instead.
  log "no seed refs resolved through the alternate; removing the partial repo"
  rm -rf -- "${GITHUB_WORKSPACE}/.git"
  exit 0
fi

log "seeded from ${seed_git_dir}: ${seeded_refs} ref(s) resolved through the alternate"
exit 0
