/// <reference types="node" />

import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const currentDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = join(currentDirectory, '..', '..');
const sourceGuardScript = join(repositoryRoot, 'scripts', 'mobile-web-bundle-check.sh');
const sourceExportScript = join(repositoryRoot, 'scripts', 'build-expo-web-export.sh');
const sourcePatchScript = join(repositoryRoot, 'scripts', 'lib', 'patch-expo-web-pwa-manifest.mjs');

const GLUE_PATH = 'board_renderer_wasm.js';
const WASM_PATH = 'board_renderer_wasm_bg.wasm';
const WORKER_PATH = 'board-render.worker.js';

// The export script's PWA-manifest step (W-24, #4438) reads the rendered shell
// and manifest.json back out of the export, so the stub has to emit real ones —
// a `touch`ed empty index.html would fail every case here for the wrong reason.
const EXPORT_SHELL_AND_MANIFEST = `cat > "$output_dir/index.html" <<'SHELL_EOF'
<!doctype html>
<html lang="en">
  <head>
    <title>Boardsesh</title>
    <link rel="manifest" href="/app/manifest.json" />
  </head>
  <body><div id="root"></div></body>
</html>
SHELL_EOF
cat > "$output_dir/manifest.json" <<'MANIFEST_EOF'
{ "name": "Boardsesh", "start_url": "/", "scope": "/" }
MANIFEST_EOF`;

describe('mobile-web-bundle-check.sh', () => {
  let fixtureRoot: string;
  let fixtureGuardScript: string;
  let sourceDirectory: string;
  let publicDirectory: string;
  let webPublicDirectory: string;

  beforeEach(() => {
    fixtureRoot = mkdtempSync(join(tmpdir(), 'mobile-web-bundle-check-'));
    fixtureGuardScript = join(fixtureRoot, 'scripts', 'mobile-web-bundle-check.sh');
    sourceDirectory = join(fixtureRoot, 'packages', 'board-renderer', 'wasm', 'pkg');
    publicDirectory = join(fixtureRoot, 'packages', 'mobile', 'public', 'wasm');
    // www serves its own copy of the same artifact to the Next.js board-render
    // worker, and the guard checks it too (issue #4495).
    webPublicDirectory = join(fixtureRoot, 'packages', 'web', 'public', 'wasm');
    const stubBinDirectory = join(fixtureRoot, 'bin');

    mkdirSync(dirname(fixtureGuardScript), { recursive: true });
    mkdirSync(sourceDirectory, { recursive: true });
    mkdirSync(publicDirectory, { recursive: true });
    mkdirSync(webPublicDirectory, { recursive: true });
    mkdirSync(stubBinDirectory, { recursive: true });
    // The guard delegates the export to build-expo-web-export.sh; ship it too.
    copyFileSync(sourceGuardScript, fixtureGuardScript);
    copyFileSync(sourceExportScript, join(fixtureRoot, 'scripts', 'build-expo-web-export.sh'));
    // …and the PWA-manifest patcher the export script shells out to.
    mkdirSync(join(fixtureRoot, 'scripts', 'lib'), { recursive: true });
    copyFileSync(sourcePatchScript, join(fixtureRoot, 'scripts', 'lib', 'patch-expo-web-pwa-manifest.mjs'));
    // Pre-seed the isolated web-runtime install so the export script skips its
    // nested pnpm install step (no network in the test).
    mkdirSync(join(fixtureRoot, 'packages', 'mobile', 'web-runtime', 'node_modules', 'react-native-web'), {
      recursive: true,
    });

    writeFileSync(join(sourceDirectory, GLUE_PATH), 'matching JavaScript glue');
    writeFileSync(join(publicDirectory, GLUE_PATH), 'matching JavaScript glue');
    writeFileSync(join(sourceDirectory, WASM_PATH), 'matching WASM binary');
    writeFileSync(join(publicDirectory, WASM_PATH), 'matching WASM binary');
    writeFileSync(join(webPublicDirectory, GLUE_PATH), 'matching JavaScript glue');
    writeFileSync(join(webPublicDirectory, WASM_PATH), 'matching WASM binary');

    const packageManagerStub = join(stubBinDirectory, 'vp');
    writeFileSync(
      packageManagerStub,
      `#!/usr/bin/env bash
set -euo pipefail
output_dir=""
while [[ $# -gt 0 ]]; do
  if [[ "$1" == "--output-dir" ]]; then
    output_dir="$2"
    break
  fi
  shift
done
mkdir -p "$output_dir/wasm"
${EXPORT_SHELL_AND_MANIFEST}
touch "$output_dir/wasm/${GLUE_PATH}"
touch "$output_dir/wasm/${WASM_PATH}"
touch "$output_dir/wasm/${WORKER_PATH}"
`,
    );
    chmodSync(packageManagerStub, 0o755);
  });

  afterEach(() => {
    rmSync(fixtureRoot, { recursive: true, force: true });
  });

  function runGuard(): SpawnSyncReturns<string> {
    return spawnSync('bash', [fixtureGuardScript], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${join(fixtureRoot, 'bin')}:${process.env.PATH ?? ''}`,
      },
    });
  }

  it('passes when the public JavaScript glue and WASM binary match their sources', () => {
    const result = runGuard();

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Expo web export is complete');
  });

  it('fails before export when the public JavaScript glue is stale', () => {
    writeFileSync(join(publicDirectory, GLUE_PATH), 'stale JavaScript glue');

    const result = runGuard();

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('public board-renderer JavaScript glue is stale');
  });

  it('fails before export when the public WASM binary is stale', () => {
    writeFileSync(join(publicDirectory, WASM_PATH), 'stale WASM binary');

    const result = runGuard();

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('public board-renderer WASM is stale');
  });

  it('fails before export when the www JavaScript glue is stale', () => {
    writeFileSync(join(webPublicDirectory, GLUE_PATH), 'stale JavaScript glue');

    const result = runGuard();

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('public board-renderer www JavaScript glue is stale');
  });

  it('fails before export when the www WASM binary is stale', () => {
    writeFileSync(join(webPublicDirectory, WASM_PATH), 'stale WASM binary');

    const result = runGuard();

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('public board-renderer www WASM is stale');
  });

  it('fails when a source or public artifact is missing', () => {
    unlinkSync(join(publicDirectory, GLUE_PATH));

    const result = runGuard();

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('missing source or public board-renderer JavaScript glue');
  });

  it('fails when the export omits the off-main-thread render worker asset', () => {
    // Re-point the export stub at one that produces the shell + WASM but NOT the
    // worker, so the guard's worker-required check is actually exercised.
    writeFileSync(
      join(fixtureRoot, 'bin', 'vp'),
      `#!/usr/bin/env bash
set -euo pipefail
output_dir=""
while [[ $# -gt 0 ]]; do
  if [[ "$1" == "--output-dir" ]]; then
    output_dir="$2"
    break
  fi
  shift
done
mkdir -p "$output_dir/wasm"
${EXPORT_SHELL_AND_MANIFEST}
touch "$output_dir/wasm/${GLUE_PATH}"
touch "$output_dir/wasm/${WASM_PATH}"
`,
    );
    chmodSync(join(fixtureRoot, 'bin', 'vp'), 0o755);

    const result = runGuard();

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('missing board-render worker asset');
  });
});
