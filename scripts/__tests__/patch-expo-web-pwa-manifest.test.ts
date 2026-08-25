/// <reference types="node" />

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// Imported as a module rather than shelled out to, so a thrown message is
// asserted directly. The CLI wrapper and its exit code are covered end-to-end by
// build-expo-web-export.test.ts.
import { patchExpoWebPwaManifest } from '../lib/patch-expo-web-pwa-manifest.mjs';

const SHELL_WITH_APP_HREF = `<!doctype html>
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

const MANIFEST = {
  name: 'Boardsesh',
  short_name: 'Boardsesh',
  start_url: '/',
  scope: '/',
  display: 'standalone',
  icons: [
    { src: 'https://www.boardsesh.com/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
    { src: 'https://www.boardsesh.com/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
    {
      src: 'https://www.boardsesh.com/icons/icon-maskable-512.png',
      sizes: '512x512',
      type: 'image/png',
      purpose: 'maskable',
    },
  ],
};

const STATIC_ASSET_MANIFEST = Object.fromEntries(
  ['/icons/icon-192.png', '/icons/icon-512.png', '/icons/icon-maskable-512.png', '/icons/apple-touch-icon.png'].map(
    (logicalPath, index) => [logicalPath, { logicalPath, objectKey: `static/v1/${String(index + 1).repeat(64)}.png` }],
  ),
);

describe('patch-expo-web-pwa-manifest', () => {
  let exportDir: string;

  beforeEach(() => {
    exportDir = mkdtempSync(join(tmpdir(), 'expo-web-manifest-'));
    mkdirSync(exportDir, { recursive: true });
    writeFileSync(join(exportDir, 'index.html'), SHELL_WITH_APP_HREF);
    writeFileSync(join(exportDir, 'manifest.json'), `${JSON.stringify(MANIFEST, null, 2)}\n`);
  });

  afterEach(() => {
    rmSync(exportDir, { recursive: true, force: true });
  });

  function readShell(): string {
    return readFileSync(join(exportDir, 'index.html'), 'utf8');
  }

  function readManifest(): Record<string, unknown> {
    return JSON.parse(readFileSync(join(exportDir, 'manifest.json'), 'utf8')) as Record<string, unknown>;
  }

  it('points the default (/app) export at /app/manifest.json with a matching scope', () => {
    patchExpoWebPwaManifest({ exportDir, basePrefix: '/app' });

    expect(readShell()).toContain('href="/app/manifest.json"');
    // start_url must sit INSIDE scope — PWA scope matching is a path-prefix
    // string compare, and "/app" is not a prefix-match inside "/app/".
    expect(readManifest().start_url).toBe('/app/');
    expect(readManifest().scope).toBe('/app/');
    expect(readShell()).toContain('https://www.boardsesh.com/icons/icon-192.png');
  });

  it('rewrites shell and manifest icons only when a static asset base URL is supplied', () => {
    const options = {
      exportDir,
      basePrefix: '',
      staticAssetBaseUrl: 'https://assets.boardsesh.com/',
      staticAssetManifest: STATIC_ASSET_MANIFEST,
    };
    patchExpoWebPwaManifest(options);

    expect(readShell()).toContain(
      `https://assets.boardsesh.com/${STATIC_ASSET_MANIFEST['/icons/icon-192.png'].objectKey}`,
    );
    expect(readShell()).toContain(
      `https://assets.boardsesh.com/${STATIC_ASSET_MANIFEST['/icons/apple-touch-icon.png'].objectKey}`,
    );
    const manifest = readManifest() as { icons: Array<{ src: string; sizes: string; purpose?: string }> };
    expect(manifest.icons.map(({ src }) => src)).toEqual([
      `https://assets.boardsesh.com/${STATIC_ASSET_MANIFEST['/icons/icon-192.png'].objectKey}`,
      `https://assets.boardsesh.com/${STATIC_ASSET_MANIFEST['/icons/icon-512.png'].objectKey}`,
      `https://assets.boardsesh.com/${STATIC_ASSET_MANIFEST['/icons/icon-maskable-512.png'].objectKey}`,
    ]);

    const firstShell = readShell();
    const firstManifest = readFileSync(join(exportDir, 'manifest.json'), 'utf8');
    patchExpoWebPwaManifest(options);
    expect(readShell()).toBe(firstShell);
    expect(readFileSync(join(exportDir, 'manifest.json'), 'utf8')).toBe(firstManifest);
  });

  it('rewrites the subdomain export to a root-relative manifest (the shipped bug)', () => {
    // This is the app.boardsesh.com case: the template's /app/manifest.json has
    // no file behind it there, so _redirects' `/* /index.html 200` catch-all
    // answered it with the SPA shell — HTML parsed as a manifest, at HTTP 200.
    patchExpoWebPwaManifest({ exportDir, basePrefix: '' });

    expect(readShell()).toContain('href="/manifest.json"');
    expect(readShell()).not.toContain('href="/app/manifest.json"');
    expect(readManifest().start_url).toBe('/');
    expect(readManifest().scope).toBe('/');
  });

  it('fails when the shell has no manifest link', () => {
    writeFileSync(join(exportDir, 'index.html'), '<!doctype html><html><head></head><body></body></html>');

    expect(() => patchExpoWebPwaManifest({ exportDir, basePrefix: '' })).toThrow(/index\.html has no <link/);
  });

  it('fails when the shell has two manifest links', () => {
    writeFileSync(
      join(exportDir, 'index.html'),
      SHELL_WITH_APP_HREF.replace(
        '<link rel="manifest" href="/app/manifest.json" />',
        '<link rel="manifest" href="/app/manifest.json" />\n    <link rel="manifest" href="/other.json" />',
      ),
    );

    expect(() => patchExpoWebPwaManifest({ exportDir, basePrefix: '' })).toThrow(/2 <link rel="manifest"> tags/);
  });

  it('fails when manifest.json is missing, leaving the shell untouched', () => {
    rmSync(join(exportDir, 'manifest.json'));

    expect(() => patchExpoWebPwaManifest({ exportDir, basePrefix: '' })).toThrow(/missing manifest\.json/);
    // All-or-nothing: a half-patched export whose shell points at a manifest
    // path with no file behind it is the exact symptom this script removes.
    expect(readShell()).toBe(SHELL_WITH_APP_HREF);
  });

  it('fails on invalid manifest JSON without truncating the file or touching the shell', () => {
    writeFileSync(join(exportDir, 'manifest.json'), '{ "name": "Boardsesh", ');

    expect(() => patchExpoWebPwaManifest({ exportDir, basePrefix: '' })).toThrow(/not valid JSON/);
    expect(readFileSync(join(exportDir, 'manifest.json'), 'utf8')).toBe('{ "name": "Boardsesh", ');
    expect(readShell()).toBe(SHELL_WITH_APP_HREF);
  });

  it('fails when the raw template overwrote the rendered shell', () => {
    // Expo substitutes %WEB_TITLE% / %LANG_ISO_CODE% when it renders
    // public/index.html. Their survival means copyPublicFolderAsync clobbered
    // the rendered shell with the template — a failure an href-only assertion
    // cannot see, because the href would look perfectly correct.
    writeFileSync(
      join(exportDir, 'index.html'),
      SHELL_WITH_APP_HREF.replace('Boardsesh</title>', '%WEB_TITLE%</title>'),
    );

    expect(() => patchExpoWebPwaManifest({ exportDir, basePrefix: '' })).toThrow(/%WEB_TITLE%/);
  });

  it('is idempotent', () => {
    patchExpoWebPwaManifest({ exportDir, basePrefix: '' });
    const firstShell = readShell();
    const firstManifest = readFileSync(join(exportDir, 'manifest.json'), 'utf8');

    patchExpoWebPwaManifest({ exportDir, basePrefix: '' });

    expect(readShell()).toBe(firstShell);
    expect(readFileSync(join(exportDir, 'manifest.json'), 'utf8')).toBe(firstManifest);
  });
});
