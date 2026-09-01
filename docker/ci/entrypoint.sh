#!/usr/bin/env bash
# Configure one ephemeral runner, serve exactly one job, exit.
#
# The host starts this container with `--rm`, so exiting throws the whole
# filesystem away and the next job starts from the image again. That is the
# entire point of running the CI image rather than extracting it: a job cannot
# be broken by whatever the previous one left behind, and no cleanup script
# has to anticipate what that might be.
#
# RUNNER_TOKEN is a *registration* token, not the PAT that minted it. The PAT
# lives in a root-only file on the host and never enters this container; the
# host's privileged ExecStartPre exchanges it for this short-lived token,
# which expires in an hour and only permits registering a runner on one repo.
# That split is what keeps a job that reads its own environment from getting
# anything worth having -- see roles/github_actions_runner/README.md in
# marcodejongh/blackheathdc-ansible.

set -euo pipefail

: "${RUNNER_TOKEN:?RUNNER_TOKEN is required}"
: "${RUNNER_REPO:?RUNNER_REPO is required (owner/name)}"
: "${RUNNER_NAME:?RUNNER_NAME is required}"
: "${RUNNER_LABELS:?RUNNER_LABELS is required}"

cd /home/runner/actions-runner

# --disableupdate: the agent version is pinned with a checksum in
# Dockerfile.ci. Letting it self-update would make a running container drift
# from the image it came from, which is exactly what rebuilding per job
# exists to prevent. Bump the ARG to take a new agent.
./config.sh \
  --url "https://github.com/${RUNNER_REPO}" \
  --token "${RUNNER_TOKEN}" \
  --name "${RUNNER_NAME}" \
  --labels "${RUNNER_LABELS}" \
  --work /home/runner/_work \
  --ephemeral \
  --unattended \
  --replace \
  --disableupdate

# Drop the token before handing control to job code. The original value is
# still readable in /proc/1/environ, so this is tidiness rather than a
# control -- the real bound is that the token expires in an hour and can only
# register a runner.
unset RUNNER_TOKEN

exec ./run.sh
