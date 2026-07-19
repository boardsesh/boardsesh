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

const GLUE_PATH = 'board_renderer_wasm.js';
const WASM_PATH = 'board_renderer_wasm_bg.wasm';

describe('mobile-web-bundle-check.sh', () => {
  let fixtureRoot: string;
  let fixtureGuardScript: string;
  let sourceDirectory: string;
  let publicDirectory: string;

  beforeEach(() => {
    fixtureRoot = mkdtempSync(join(tmpdir(), 'mobile-web-bundle-check-'));
    fixtureGuardScript = join(fixtureRoot, 'scripts', 'mobile-web-bundle-check.sh');
    sourceDirectory = join(fixtureRoot, 'packages', 'board-renderer', 'wasm', 'pkg');
    publicDirectory = join(fixtureRoot, 'packages', 'mobile', 'public', 'wasm');
    const stubBinDirectory = join(fixtureRoot, 'bin');

    mkdirSync(dirname(fixtureGuardScript), { recursive: true });
    mkdirSync(sourceDirectory, { recursive: true });
    mkdirSync(publicDirectory, { recursive: true });
    mkdirSync(stubBinDirectory, { recursive: true });
    copyFileSync(sourceGuardScript, fixtureGuardScript);

    writeFileSync(join(sourceDirectory, GLUE_PATH), 'matching JavaScript glue');
    writeFileSync(join(publicDirectory, GLUE_PATH), 'matching JavaScript glue');
    writeFileSync(join(sourceDirectory, WASM_PATH), 'matching WASM binary');
    writeFileSync(join(publicDirectory, WASM_PATH), 'matching WASM binary');

    const bunxStub = join(stubBinDirectory, 'bunx');
    writeFileSync(
      bunxStub,
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
touch "$output_dir/index.html"
touch "$output_dir/wasm/${GLUE_PATH}"
touch "$output_dir/wasm/${WASM_PATH}"
`,
    );
    chmodSync(bunxStub, 0o755);
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

  it('fails when a source or public artifact is missing', () => {
    unlinkSync(join(publicDirectory, GLUE_PATH));

    const result = runGuard();

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('missing source or public board-renderer JavaScript glue');
  });
});
