#!/usr/bin/env node
// Normalises an Expo web export's PWA manifest wiring to that export's baseUrl.
//
// Two inputs of the export are baseUrl-blind:
//   - packages/mobile/public/index.html is a checked-in template whose
//     `<link rel="manifest">` href is a fixed `/app/manifest.json` (the value
//     the dev Metro proxy needs — next.config.mjs rewrites /app/manifest.json
//     to Metro's /manifest.json).
//   - packages/mobile/public/manifest.json is copied verbatim into the export
//     root, with `start_url`/`scope` written for root serving.
//
// Neither knows which baseUrl this export was built with. On the --subdomain
// export the href points at /app/manifest.json, a path with no file behind it,
// and Cloudflare Pages' `/* /index.html 200` catch-all answers it with the SPA
// shell: the browser parses HTML as a manifest, logs an error on every load and
// never offers the install prompt — all at HTTP 200, invisible to a status-code
// check. This rewrites both files from the export's baseUrl, then re-reads them
// from disk and asserts the rewrite landed, because a silent no-op here is the
// exact failure mode being fixed. When production provides
// EXPO_PUBLIC_STATIC_ASSET_BASE_URL, it also replaces the checked-in www icon
// URLs with the content-addressed catalog objects. Local/PR exports leave those
// URLs alone because main is the only CDN publisher. See W-24 / #4438.

import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const LOG_PREFIX = '[patch-expo-web-pwa-manifest]';
// A factory, not a module-level literal. A `/g` regex carries `lastIndex`
// between uses; `String.prototype.match` resets it, but anything reaching for
// `.exec()` or `.test()` later would silently start mid-string on the second
// call. Handing out a fresh regex removes the trap rather than documenting it.
const manifestLinkPattern = () => /<link\b[^>]*\brel=["']manifest["'][^>]*>/gi;
// Expo substitutes these when it renders public/index.html as the SPA shell
// (@expo/cli's webTemplate.js). Their survival into the export means
// copyPublicFolderAsync clobbered the rendered shell with the raw template — a
// failure an href-only assertion cannot see.
//
// Exported so packages/mobile/src/__tests__/web-shell-appearance.test.ts can
// assert the real template still contains every one of them. Without that pin,
// hardcoding the template's title/lang — a natural, harmless-looking edit —
// would silently turn this whole check into dead code.
export const UNRENDERED_TEMPLATE_TOKENS = ['%WEB_TITLE%', '%LANG_ISO_CODE%'];

function fail(message) {
  throw new Error(`${LOG_PREFIX} ${message}`);
}

function readRequired(filePath, label) {
  try {
    return readFileSync(filePath, 'utf8');
  } catch {
    // Throw here rather than call fail(): a `fail(); return ''` tail would be
    // unreachable code that reads like an empty-string fallback.
    throw new Error(`${LOG_PREFIX} missing ${label} at ${filePath}`);
  }
}

function findManifestLinks(shellHtml) {
  return shellHtml.match(manifestLinkPattern()) ?? [];
}

function hrefOf(linkTag) {
  const matched = /\bhref=["']([^"']*)["']/i.exec(linkTag);
  return matched ? matched[1] : null;
}

function findLinkByRel(shellHtml, relation) {
  const links = shellHtml.match(/<link\b[^>]*>/gi) ?? [];
  return links.filter((link) => {
    const matched = /\brel=["']([^"']*)["']/i.exec(link);
    return matched?.[1].split(/\s+/).includes(relation);
  });
}

function staticAssetUrl(staticAssetManifest, staticAssetBaseUrl, logicalPath) {
  const objectKey = staticAssetManifest?.[logicalPath];
  if (typeof objectKey !== 'string' || objectKey === '') fail(`static asset catalog has no ${logicalPath}`);
  return `${staticAssetBaseUrl.replace(/\/$/, '')}/${objectKey}`;
}

function patchShellIcon(shellHtml, relation, iconUrl, shellPath) {
  const links = findLinkByRel(shellHtml, relation);
  if (links.length !== 1) {
    fail(`index.html has ${links.length} <link rel="${relation}"> tags (${shellPath}) — expected exactly one`);
  }
  const originalLink = links[0];
  const originalHref = hrefOf(originalLink);
  if (originalHref === null) {
    fail(`<link rel="${relation}"> has no href (${shellPath})`);
  }
  if (originalHref === iconUrl) return shellHtml;
  const patchedLink = originalLink.replace(/\bhref=["'][^"']*["']/i, `href="${iconUrl}"`);
  return shellHtml.replace(originalLink, patchedLink);
}

function patchManifestIcons(manifest, staticAssetManifest, staticAssetBaseUrl) {
  if (!Array.isArray(manifest.icons)) fail('manifest.json has no icons array');
  const catalogUrls = new Set(
    Object.keys(staticAssetManifest ?? {}).map((logicalPath) =>
      staticAssetUrl(staticAssetManifest, staticAssetBaseUrl, logicalPath),
    ),
  );
  for (const icon of manifest.icons) {
    if (typeof icon?.src !== 'string' || icon.src.trim() === '') {
      fail(`manifest icon has no source: ${JSON.stringify(icon)}`);
    }
    if (catalogUrls.has(icon.src)) continue;

    let logicalPath;
    try {
      logicalPath = new URL(icon.src, 'https://www.boardsesh.com').pathname;
    } catch {
      fail(`manifest icon has an invalid source URL: ${JSON.stringify(icon.src)}`);
    }
    icon.src = staticAssetUrl(staticAssetManifest, staticAssetBaseUrl, logicalPath);
  }
}

/**
 * Rewrite an Expo web export's manifest href, start_url and scope from the
 * export's baseUrl.
 *
 * @param {{ exportDir: string, basePrefix: string, staticAssetBaseUrl?: string, staticAssetManifest?: object }} options
 *   `basePrefix` is the baseUrl with no trailing slash: '/app' for the default
 *   export, '' for the root-served --subdomain export.
 * @returns {{ href: string, startUrl: string }}
 */
export function patchExpoWebPwaManifest({ exportDir, basePrefix, staticAssetBaseUrl, staticAssetManifest }) {
  const shellPath = join(exportDir, 'index.html');
  const manifestPath = join(exportDir, 'manifest.json');
  const expectedHref = `${basePrefix}/manifest.json`;
  const expectedStartUrl = `${basePrefix}/`;

  const shellHtml = readRequired(shellPath, 'index.html');

  const manifestLinks = findManifestLinks(shellHtml);
  if (manifestLinks.length === 0) {
    fail(`index.html has no <link rel="manifest"> tag (${shellPath}) — the shell template lost its manifest link`);
  }
  if (manifestLinks.length > 1) {
    fail(`index.html has ${manifestLinks.length} <link rel="manifest"> tags (${shellPath}) — expected exactly one`);
  }

  const unrendered = UNRENDERED_TEMPLATE_TOKENS.filter((token) => shellHtml.includes(token));
  if (unrendered.length > 0) {
    fail(
      `index.html still contains unsubstituted template token(s) ${unrendered.join(', ')} (${shellPath}) — ` +
        'the raw public/index.html template overwrote the rendered shell',
    );
  }

  // Validate BOTH files before writing EITHER. A manifest-side failure after
  // index.html was already rewritten would leave a half-patched export on disk:
  // a shell pointing at a manifest path with no file behind it, which is the
  // very symptom this script exists to remove — and nothing tells the operator
  // the directory is poisoned. All-or-nothing instead.
  const manifestSource = readRequired(manifestPath, 'manifest.json');
  let manifest;
  try {
    manifest = JSON.parse(manifestSource);
  } catch (error) {
    fail(
      `manifest.json is not valid JSON (${manifestPath}): ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const originalLink = manifestLinks[0];
  const patchedLink = originalLink.replace(/\bhref=["'][^"']*["']/i, `href="${expectedHref}"`);
  let patchedShell = shellHtml.replace(originalLink, patchedLink);

  manifest.start_url = expectedStartUrl;
  manifest.scope = expectedStartUrl;
  if (staticAssetBaseUrl) {
    patchedShell = patchShellIcon(
      patchedShell,
      'icon',
      staticAssetUrl(staticAssetManifest, staticAssetBaseUrl, '/icons/icon-192.png'),
      shellPath,
    );
    patchedShell = patchShellIcon(
      patchedShell,
      'apple-touch-icon',
      staticAssetUrl(staticAssetManifest, staticAssetBaseUrl, '/icons/apple-touch-icon.png'),
      shellPath,
    );
    patchManifestIcons(manifest, staticAssetManifest, staticAssetBaseUrl);
  }

  writeFileSync(shellPath, patchedShell);
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  // Re-read from disk. Everything above operated on in-memory strings; only a
  // fresh read proves the bytes a browser will fetch actually changed.
  const writtenShell = readFileSync(shellPath, 'utf8');
  const writtenLinks = findManifestLinks(writtenShell);
  if (writtenLinks.length !== 1) {
    fail(`post-write check: expected exactly one <link rel="manifest"> in ${shellPath}, found ${writtenLinks.length}`);
  }
  const writtenHref = hrefOf(writtenLinks[0]);
  if (writtenHref !== expectedHref) {
    fail(`post-write check: manifest href is ${JSON.stringify(writtenHref)}, expected ${JSON.stringify(expectedHref)}`);
  }

  const writtenManifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (writtenManifest.start_url !== expectedStartUrl || writtenManifest.scope !== expectedStartUrl) {
    fail(
      `post-write check: manifest start_url/scope are ${JSON.stringify(writtenManifest.start_url)}/` +
        `${JSON.stringify(writtenManifest.scope)}, expected ${JSON.stringify(expectedStartUrl)}`,
    );
  }

  if (staticAssetBaseUrl) {
    const expectedIconUrl = staticAssetUrl(staticAssetManifest, staticAssetBaseUrl, '/icons/icon-192.png');
    if (!writtenShell.includes(expectedIconUrl)) fail(`post-write check: index.html is missing ${expectedIconUrl}`);
    for (const icon of writtenManifest.icons ?? []) {
      if (typeof icon.src !== 'string' || !icon.src.startsWith(`${staticAssetBaseUrl.replace(/\/$/, '')}/`)) {
        fail(`post-write check: manifest icon did not use ${staticAssetBaseUrl}`);
      }
    }
  }

  return { href: expectedHref, startUrl: expectedStartUrl, staticAssetsPatched: Boolean(staticAssetBaseUrl) };
}

function main(argv) {
  const [exportDir, basePrefix = '', staticAssetManifestPath] = argv;
  if (!exportDir) {
    fail('usage: node scripts/lib/patch-expo-web-pwa-manifest.mjs <export-dir> [base-prefix]');
  }
  const staticAssetBaseUrl = process.env.EXPO_PUBLIC_STATIC_ASSET_BASE_URL?.trim();
  let staticAssetManifest;
  if (staticAssetBaseUrl) {
    if (!staticAssetManifestPath) fail('static asset base URL is set but no catalog path was provided');
    try {
      staticAssetManifest = JSON.parse(readRequired(staticAssetManifestPath, 'static asset catalog'));
    } catch (error) {
      fail(`static asset catalog is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const { href, startUrl, staticAssetsPatched } = patchExpoWebPwaManifest({
    exportDir,
    basePrefix,
    staticAssetBaseUrl,
    staticAssetManifest,
  });
  console.log(
    `${LOG_PREFIX} index.html manifest href → "${href}"; manifest.json start_url/scope → "${startUrl}"; CDN icons ${staticAssetsPatched ? 'patched' : 'unchanged'}`,
  );
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
