import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { UNRENDERED_TEMPLATE_TOKENS } from '../../../../scripts/lib/patch-expo-web-pwa-manifest.mjs';

const shellSource = readFileSync(new URL('../../public/index.html', import.meta.url), 'utf8');

describe('Expo web HTML appearance shell', () => {
  it('paints dark before React mounts', () => {
    expect(shellSource).toMatch(
      /html,\s*body\s*\{[\s\S]*?background-color:\s*#000000;[\s\S]*?color-scheme:\s*dark;[\s\S]*?\}/,
    );
    expect(shellSource).toMatch(/#root\s*\{[\s\S]*?background-color:\s*#000000;[\s\S]*?\}/);
  });

  it('paints a loading state, not an empty black rectangle', () => {
    // The shell is what the browser has while it downloads and evaluates the
    // entry bundle — tens of seconds on a cold cache over mobile data. #root was
    // empty, so that whole window rendered as a black page and read as a broken
    // app. These children are dropped by React on first commit (Expo's web entry
    // uses createRoot, which clears the container), so they are safe to ship and
    // need no teardown.
    expect(shellSource).toMatch(/<div id="root">[\s\S]*<div id="boot-paint">/);
    expect(shellSource).toMatch(/#boot-paint\s*\{/);

    // No script and no external reference: a boot paint that has to fetch
    // something cannot paint before the thing it is covering for.
    const bootPaintMarkup = shellSource.slice(shellSource.indexOf('<div id="root">'));
    expect(bootPaintMarkup).not.toMatch(/<script/i);
    expect(bootPaintMarkup).not.toMatch(/(src|href)=/i);
  });

  it('holds the boot animation still for reduced-motion readers', () => {
    // An indeterminate bar with no end can run for half a minute here.
    expect(shellSource).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*?animation: none;/);
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

  it('keeps the template tokens the export patcher watches for', () => {
    // The patcher fails an export whose shell still contains these, because
    // that means copyPublicFolderAsync overwrote Expo's rendered shell with this
    // raw template — an export that would ship with no bundle <script> tags at
    // all, at HTTP 200. Hardcoding the title/lang here (a natural-looking edit)
    // would leave that detector matching nothing, with no test going red.
    // Imported from the patcher, not restated, so the two cannot drift apart.
    for (const token of UNRENDERED_TEMPLATE_TOKENS as string[]) {
      expect(shellSource).toContain(token);
    }
  });
});
