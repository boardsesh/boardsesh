#!/usr/bin/env bash
# Install one or more Pythons into the hosted tool cache, in the exact layout
# actions/setup-python looks for (issue #5050).
#
#   install-python.sh 3.11.16 3.12.14
#
# Why not apt. Two independent reasons, either of which alone would be fatal:
#
#   * setup-python checks the tool cache and otherwise downloads a build from
#     actions/python-versions, which publishes UBUNTU builds only. On this
#     Debian image the lookup fails outright with "The version '3.11' with
#     architecture 'x64' was not found for this operating system", so an apt
#     Python would not be found even if it were present.
#   * Debian's system Python is PEP 668 externally-managed, so `pip install`
#     into it fails. firmware-tests does exactly that (`pip install platformio`).
#
# The upstream tarballs solve both: relocatable, not externally managed, and
# their own setup.sh writes the layout plus the `.complete` marker file that
# setup-python actually tests for (the marker, not the directory, is what it
# checks).

set -Eeuo pipefail

# 22.04 is deliberate, not merely "recent enough". That build targets glibc
# 2.35, older than bookworm's 2.36, so it runs here. The 24.04 build targets
# 2.39 and would fail at exec time — on a runner that would look like a broken
# job rather than a bad image.
: "${PYTHON_BUILD_PLATFORM:=22.04}"
: "${AGENT_TOOLSDIRECTORY:=/opt/hostedtoolcache}"
export AGENT_TOOLSDIRECTORY

MANIFEST_URL=https://raw.githubusercontent.com/actions/python-versions/main/versions-manifest.json

[ "$#" -gt 0 ] || { echo "usage: $0 <version>..." >&2; exit 2; }

manifest="$(mktemp)"
trap 'rm -rf -- "$manifest" "${workdir:-}"' EXIT
curl -fsSL -o "$manifest" "$MANIFEST_URL"

for version in "$@"; do
  # node, not python: the whole point is that this runs before a usable Python
  # exists, and the base image is node:22.
  download_url="$(
    MANIFEST_PATH="$manifest" WANT_VERSION="$version" WANT_PLATFORM="$PYTHON_BUILD_PLATFORM" \
      node -e '
        const releases = JSON.parse(require("fs").readFileSync(process.env.MANIFEST_PATH, "utf8"));
        const release = releases.find((entry) => entry.version === process.env.WANT_VERSION);
        if (!release) throw new Error(`no release for ${process.env.WANT_VERSION}`);
        const file = release.files.find(
          (candidate) =>
            candidate.platform === "linux" &&
            candidate.platform_version === process.env.WANT_PLATFORM &&
            candidate.arch === "x64",
        );
        if (!file) {
          throw new Error(
            `no linux-${process.env.WANT_PLATFORM}-x64 build for ${process.env.WANT_VERSION}`,
          );
        }
        process.stdout.write(file.download_url);
      '
  )"

  echo "Installing Python ${version} from ${download_url}"
  workdir="$(mktemp -d)"
  curl -fsSL "$download_url" | tar xz -C "$workdir"
  # setup.sh ships without the executable bit in the tarball.
  ( cd "$workdir" && bash ./setup.sh )
  rm -rf -- "$workdir"

  # Prove it landed where setup-python will look, rather than trusting
  # setup.sh's exit code. A missing marker is the failure mode that would only
  # show up later as a mysterious re-download on every job.
  marker="${AGENT_TOOLSDIRECTORY}/Python/${version}/x64.complete"
  [ -f "$marker" ] || { echo "expected marker missing: ${marker}" >&2; exit 1; }
  "${AGENT_TOOLSDIRECTORY}/Python/${version}/x64/bin/python3" --version
done
