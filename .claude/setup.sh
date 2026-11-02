#!/usr/bin/env bash
set -euo pipefail

# Never in GitHub Actions. claude-code-action restores .claude/ from the PR's base
# but runs this SessionStart hook in a checkout of the PR head, on the default
# branch's ref. `vp install` there would run the PR's lifecycle scripts in a
# default-branch run. The Actions workflows set up anything they need themselves.
# Guarded by scripts/__tests__/untrusted-code-workflow-guard.test.ts.
if [ "${GITHUB_ACTIONS:-}" = "true" ]; then
  echo "==> GitHub Actions: skipping local setup."
  exit 0
fi

echo "==> Installing dependencies..."
vp install

echo "==> Installing git hooks..."
vp config
./scripts/configure-git-hooks.sh

echo "==> Ensuring gh CLI is installed..."
if ! command -v gh &>/dev/null; then
  GH_VERSION=$(curl -sI https://github.com/cli/cli/releases/latest | grep -i '^location:' | sed 's|.*/tag/v||;s/\r//')
  echo "  Installing gh v${GH_VERSION}..."
  curl -sL "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_amd64.tar.gz" -o /tmp/gh.tar.gz
  tar -xzf /tmp/gh.tar.gz -C /tmp
  sudo mv "/tmp/gh_${GH_VERSION}_linux_amd64/bin/gh" /usr/local/bin/gh
  rm -rf /tmp/gh.tar.gz "/tmp/gh_${GH_VERSION}_linux_amd64"
  echo "  gh installed: $(gh --version | head -1)"
else
  echo "  gh already installed: $(gh --version | head -1)"
fi

echo "==> Checking gh authentication..."
if [ -n "${GH_TOKEN:-}" ]; then
  if gh auth status &>/dev/null; then
    echo "  gh authenticated successfully"
  else
    echo "  Warning: GH_TOKEN is set but gh auth status failed"
  fi
else
  echo "  Note: GH_TOKEN not set — set it as a secret in Claude Code web settings for GitHub access"
fi

echo "==> Session setup complete"
