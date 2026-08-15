import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const shellSource = readFileSync(new URL('../../public/index.html', import.meta.url), 'utf8');

describe('Expo web HTML appearance shell', () => {
  it('paints dark before React mounts', () => {
    expect(shellSource).toMatch(
      /html,\s*body\s*\{[\s\S]*?background-color:\s*#000000;[\s\S]*?color-scheme:\s*dark;[\s\S]*?\}/,
    );
    expect(shellSource).toMatch(/#root\s*\{[\s\S]*?background-color:\s*#000000;[\s\S]*?\}/);
  });

  it('keeps exactly one manifest link, at the dev/Metro-proxy href', () => {
    // /app/manifest.json is the DEV value: Metro serves public/ from its server
    // root, and next.config.mjs rewrites /app/manifest.json to Metro's
    // /manifest.json. It is also the export patcher's expected input.
    //
    // The natural-but-wrong fix for the app.boardsesh.com install prompt is to
    // hand-edit this to /manifest.json. Don't — that breaks the dev proxy and
    // fixes nothing, because a single literal cannot be right for both baseUrls.
    // scripts/lib/patch-expo-web-pwa-manifest.mjs rewrites it per export from
    // that export's own baseUrl and asserts the result (W-24, #4438).
    const manifestLinks = shellSource.match(/<link\b[^>]*\brel=["']manifest["'][^>]*>/gi) ?? [];
    expect(manifestLinks).toHaveLength(1);
    expect(manifestLinks[0]).toContain('href="/app/manifest.json"');
  });
});
