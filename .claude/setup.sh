#!/usr/bin/env bash
set -euo pipefail

echo "==> Installing dependencies..."
vp install

echo "==> Installing git hooks..."
vp config

# Install the Conventional Commit message hook alongside vp's pre-commit, without
# flipping core.hooksPath. Best-effort; CI's commit-lint job is the real gate.
HOOKS_DIR=$(git rev-parse --git-path hooks 2>/dev/null || true)
if [ -n "${HOOKS_DIR}" ] && [ -f .githooks/commit-msg ]; then
  mkdir -p "${HOOKS_DIR}"
  cp .githooks/commit-msg "${HOOKS_DIR}/commit-msg"
  chmod +x "${HOOKS_DIR}/commit-msg"
  echo "  commit-msg hook installed (best-effort; CI's commit-lint job is authoritative)"
fi

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
