/// <reference types="node" />

import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const currentDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = join(currentDirectory, '..', '..');
const sourceExportScript = join(repositoryRoot, 'scripts', 'build-expo-web-export.sh');
const sourcePatchScript = join(repositoryRoot, 'scripts', 'lib', 'patch-expo-web-pwa-manifest.mjs');

// The shell Expo renders from packages/mobile/public/index.html: one manifest
// link whose href is the baseUrl-blind template value, and the %…% tokens
// already substituted.
const RENDERED_SHELL = `<!doctype html>
<html lang="en">
  <head>
    <title>Boardsesh</title>
    <link rel="manifest" href="/app/manifest.json" />
    <link rel="icon" href="https://www.boardsesh.com/icons/icon-192.png" />
    <link rel="apple-touch-icon" href="https://www.boardsesh.com/icons/apple-touch-icon.png" />
  </head>
  <body><div id="root"></div></body>
</html>
`;

const PUBLIC_MANIFEST = `{
  "name": "Boardsesh",
  "start_url": "/",
  "scope": "/",
  "icons": [
    { "src": "https://www.boardsesh.com/icons/icon-192.png", "sizes": "192x192" },
    { "src": "https://www.boardsesh.com/icons/icon-512.png", "sizes": "512x512" },
    { "src": "https://www.boardsesh.com/icons/icon-maskable-512.png", "sizes": "512x512", "purpose": "maskable" }
  ]
}
`;

const STATIC_ASSET_MANIFEST = Object.fromEntries(
  ['/icons/icon-192.png', '/icons/icon-512.png', '/icons/icon-maskable-512.png', '/icons/apple-touch-icon.png'].map(
    (logicalPath, index) => [logicalPath, `static/v1/${String(index + 1).repeat(64)}.png`],
  ),
);

function vpStub({ shell }: { shell: string }): string {
  return `#!/usr/bin/env bash
set -euo pipefail
output_dir=""
while [[ $# -gt 0 ]]; do
  if [[ "$1" == "--output-dir" ]]; then
    output_dir="$2"
    break
  fi
  shift
done
mkdir -p "$output_dir/wasm" "$output_dir/_expo/static/js/web"
cat > "$output_dir/index.html" <<'SHELL_EOF'
${shell}SHELL_EOF
cat > "$output_dir/manifest.json" <<'MANIFEST_EOF'
${PUBLIC_MANIFEST}MANIFEST_EOF
touch "$output_dir/wasm/board_renderer_wasm.js"
touch "$output_dir/wasm/board_renderer_wasm_bg.wasm"
`;
}

describe('build-expo-web-export.sh PWA manifest patching', () => {
  let fixtureRoot: string;
  let fixtureExportScript: string;

  function writeVpStub(shell: string): void {
    const stubPath = join(fixtureRoot, 'bin', 'vp');
    writeFileSync(stubPath, vpStub({ shell }));
    chmodSync(stubPath, 0o755);
  }

  beforeEach(() => {
    fixtureRoot = mkdtempSync(join(tmpdir(), 'build-expo-web-export-'));
    fixtureExportScript = join(fixtureRoot, 'scripts', 'build-expo-web-export.sh');

    mkdirSync(join(fixtureRoot, 'scripts', 'lib'), { recursive: true });
    mkdirSync(join(fixtureRoot, 'bin'), { recursive: true });
    mkdirSync(join(fixtureRoot, 'packages', 'mobile', 'public'), { recursive: true });
    mkdirSync(join(fixtureRoot, 'packages', 'web', 'public'), { recursive: true });
    mkdirSync(join(fixtureRoot, 'packages', 'shared', 'static-assets', 'src', 'generated'), { recursive: true });
    // Pre-seed the isolated web-runtime install so the export script skips its
    // nested pnpm install step (no network in the test).
    mkdirSync(join(fixtureRoot, 'packages', 'mobile', 'web-runtime', 'node_modules', 'react-native-web'), {
      recursive: true,
    });

    copyFileSync(sourceExportScript, fixtureExportScript);
    copyFileSync(sourcePatchScript, join(fixtureRoot, 'scripts', 'lib', 'patch-expo-web-pwa-manifest.mjs'));
    writeFileSync(
      join(fixtureRoot, 'packages', 'shared', 'static-assets', 'src', 'generated', 'catalog.json'),
      JSON.stringify(STATIC_ASSET_MANIFEST),
    );

    writeVpStub(RENDERED_SHELL);
  });

  afterEach(() => {
    rmSync(fixtureRoot, { recursive: true, force: true });
  });

  function runExportWithEnvironment(
    environment: Readonly<Record<string, string | undefined>>,
    ...args: string[]
  ): SpawnSyncReturns<string> {
    return spawnSync('bash', [fixtureExportScript, ...args], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${join(fixtureRoot, 'bin')}:${process.env.PATH ?? ''}`,
        EXPO_PUBLIC_STATIC_ASSET_BASE_URL: '',
        ...environment,
      },
    });
  }

  function runExport(...args: string[]): SpawnSyncReturns<string> {
    return runExportWithEnvironment({}, ...args);
  }

  it('patches the default export to /app/manifest.json and start_url /app/', () => {
    const result = runExport();

    expect(result.status).toBe(0);
    const outputDir = join(fixtureRoot, 'packages', 'web', 'public', 'app');
    expect(readFileSync(join(outputDir, 'index.html'), 'utf8')).toContain('href="/app/manifest.json"');
    const manifest = JSON.parse(readFileSync(join(outputDir, 'manifest.json'), 'utf8')) as Record<string, unknown>;
    expect(manifest.start_url).toBe('/app/');
    expect(manifest.scope).toBe('/app/');
  });

  it('patches the --subdomain export to a root-relative manifest', () => {
    const result = runExport('--subdomain');

    expect(result.status).toBe(0);
    // --subdomain defaults the output to packages/web/public/app-standalone.
    const outputDir = join(fixtureRoot, 'packages', 'web', 'public', 'app-standalone');
    const shell = readFileSync(join(outputDir, 'index.html'), 'utf8');
    expect(shell).toContain('href="/manifest.json"');
    expect(shell).not.toContain('href="/app/manifest.json"');
    const manifest = JSON.parse(readFileSync(join(outputDir, 'manifest.json'), 'utf8')) as Record<string, unknown>;
    expect(manifest.start_url).toBe('/');
    expect(manifest.scope).toBe('/');
  });

  it('patches immutable icon URLs into the production export only', () => {
    const result = runExportWithEnvironment(
      { EXPO_PUBLIC_STATIC_ASSET_BASE_URL: 'https://assets.boardsesh.com' },
      '--subdomain',
    );

    expect(result.status).toBe(0);
    const outputDir = join(fixtureRoot, 'packages', 'web', 'public', 'app-standalone');
    const shell = readFileSync(join(outputDir, 'index.html'), 'utf8');
    expect(shell).toContain(`https://assets.boardsesh.com/${STATIC_ASSET_MANIFEST['/icons/icon-192.png']}`);
    const manifest = JSON.parse(readFileSync(join(outputDir, 'manifest.json'), 'utf8')) as {
      icons: Array<{ src: string }>;
    };
    expect(manifest.icons.every(({ src }) => src.startsWith('https://assets.boardsesh.com/static/v1/'))).toBe(true);
  });

  it('fails the export when the shell lost its manifest link', () => {
    writeVpStub(RENDERED_SHELL.replace('<link rel="manifest" href="/app/manifest.json" />\n', ''));

    const result = runExport('--subdomain');

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('[patch-expo-web-pwa-manifest]');
  });
});
