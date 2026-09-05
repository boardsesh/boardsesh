#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# SPDX-FileCopyrightText: 2026 Boardsesh
set -euo pipefail
cd "$(dirname "$0")"
if [ -d "$HOME/.rustup/toolchains/stable-$(rustc -vV | grep host | cut -d' ' -f2)/bin" ]; then
  export PATH="$HOME/.rustup/toolchains/stable-$(rustc -vV | grep host | cut -d' ' -f2)/bin:$PATH"
fi
wasm-pack build --target web --out-dir pkg
echo "WASM build complete. Output in pkg/"
