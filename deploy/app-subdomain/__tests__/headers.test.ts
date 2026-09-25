import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { effectiveHeaderValues, headerBlocks } from './cloudflare-config';

// Guards the Cloudflare Pages `_headers` config shipped to app.boardsesh.com
// (see ../README.md). This is the only check standing between a well-meant
// "add a CSP" PR and a dark board renderer in production.

/** Split a CSP into directive name -> source tokens. */
function parseCspDirectives(csp: string): Map<string, string[]> {
  const directives = new Map<string, string[]>();
  for (const directive of csp.split(';')) {
    const [name, ...sources] = directive.trim().split(/\s+/);
    if (name) directives.set(name.toLowerCase(), sources);
  }
  return directives;
}

/**
 * The Expo shell's inline scripts (packages/mobile/public/index.html). The
 * chunk-recovery one (#5611) is the only thing that recovers a failed root
 * layout chunk, and a CSP that blocks inline scripts disables it silently.
 */
const shellSource = readFileSync(
  resolve(import.meta.dirname, '..', '..', '..', 'packages', 'mobile', 'public', 'index.html'),
  'utf8',
);
const inlineScriptHashes = [...shellSource.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(
  ([, body]) => `'sha256-${createHash('sha256').update(body, 'utf8').digest('base64')}'`,
);

/**
 * Why a CSP would block the shell's inline scripts, or null if it allows them.
 * No script-src/default-src means no restriction. A hash or nonce in the
 * directive makes browsers ignore 'unsafe-inline', so then every inline script's
 * hash must be listed; otherwise 'unsafe-inline' must be.
 */
function inlineScriptBlockReason(csp: string, requiredHashes: readonly string[]): string | null {
  const directives = parseCspDirectives(csp);
  const scriptSources = directives.get('script-src') ?? directives.get('default-src');
  if (!scriptSources) return null;
  const usesHashOrNonce = scriptSources.some((source) => /^'(sha256|sha384|sha512|nonce)-/.test(source));
  if (usesHashOrNonce) {
    const missing = requiredHashes.filter((hash) => !scriptSources.includes(hash));
    return missing.length
      ? `lists hashes/nonces but not the shell's inline script hash(es) ${missing.join(' ')}`
      : null;
  }
  return scriptSources.includes("'unsafe-inline'") ? null : "allows neither 'unsafe-inline' nor the inline script hash";
}

describe('deploy/app-subdomain/_headers', () => {
  it('parses at least one block (sanity check the fixture path is right)', () => {
    expect(headerBlocks.length).toBeGreaterThan(0);
  });

  // The hard rule from README.md: the board-renderer WASM glue instantiates via
  // `new Function(...)`, so any CSP that restricts script sources without both
  // eval allowances breaks the renderer outright. `script-src` falls back to
  // `default-src`, so a `default-src`-only policy kills it just as dead — both
  // spellings have to be caught. Tokens are compared exactly, because
  // `'wasm-unsafe-eval'` contains `unsafe-eval` as a substring but does not
  // permit `new Function(...)`.
  it('never restricts script sources without unsafe-eval AND wasm-unsafe-eval', () => {
    for (const block of headerBlocks) {
      for (const [name, values] of block.headers) {
        if (name.toLowerCase() !== 'content-security-policy') continue;
        for (const csp of values) {
          const directives = parseCspDirectives(csp);
          const scriptSources = directives.get('script-src') ?? directives.get('default-src');
          if (!scriptSources) continue;

          const context = `${block.path} sets a CSP ("${csp}") restricting script sources`;
          expect(
            scriptSources,
            `${context} without 'unsafe-eval' — breaks the board-renderer WASM glue (new Function(...)). See README.md.`,
          ).toContain("'unsafe-eval'");
          expect(
            scriptSources,
            `${context} without 'wasm-unsafe-eval' — breaks the board-renderer WASM glue. See README.md.`,
          ).toContain("'wasm-unsafe-eval'");
        }
      }
    }
  });

  // The chunk-recovery script in the Expo shell (#5611) is inline. A future CSP
  // that restricts scripts without allowing it would pass the eval rule above
  // and silently leave a failed root layout chunk as a black page.
  it("never blocks the shell's inline chunk-recovery script", () => {
    expect(inlineScriptHashes.length, 'the shell should carry the inline recovery script').toBeGreaterThan(0);
    for (const block of headerBlocks) {
      for (const [name, values] of block.headers) {
        if (name.toLowerCase() !== 'content-security-policy') continue;
        for (const csp of values) {
          const reason = inlineScriptBlockReason(csp, inlineScriptHashes);
          expect(
            reason,
            `${block.path} sets a CSP ("${csp}") that ${reason} — it disables the shell's chunk-recovery script (packages/mobile/public/index.html). See README.md.`,
          ).toBeNull();
        }
      }
    }
  });

  it('the inline-script CSP check catches a policy that would block the script (fixtures)', () => {
    const [scriptHash] = inlineScriptHashes;
    const evalOnly = "script-src 'self' 'unsafe-eval' 'wasm-unsafe-eval'";
    expect(inlineScriptBlockReason("frame-ancestors 'none'", inlineScriptHashes)).toBeNull();
    expect(inlineScriptBlockReason(evalOnly, inlineScriptHashes)).not.toBeNull();
    expect(
      inlineScriptBlockReason("default-src 'self' 'unsafe-eval' 'wasm-unsafe-eval'", inlineScriptHashes),
    ).not.toBeNull();
    expect(inlineScriptBlockReason(`${evalOnly} 'unsafe-inline'`, inlineScriptHashes)).toBeNull();
    expect(inlineScriptBlockReason(`${evalOnly} ${scriptHash}`, inlineScriptHashes)).toBeNull();
    // A hash of something else switches 'unsafe-inline' off in browsers.
    expect(
      inlineScriptBlockReason(`${evalOnly} 'unsafe-inline' 'sha256-${'A'.repeat(43)}='`, inlineScriptHashes),
    ).not.toBeNull();
  });

  it('applies X-Robots-Tag: noindex to every path', () => {
    const robotsTags = effectiveHeaderValues('/index.html', 'X-Robots-Tag');
    expect(robotsTags.join(', ')).toContain('noindex');
  });

  // Asserted against concrete request paths rather than block names, so the
  // check follows what Cloudflare would actually send. `/*` spans `/`, so a
  // cache rule parked there reaches every path below.
  it('caches content-hashed assets forever', () => {
    for (const hashedAssetPath of ['/_expo/static/js/web/entry-abc123.js', '/assets/logo-abc123.png']) {
      const cacheControl = effectiveHeaderValues(hashedAssetPath, 'Cache-Control').join(', ');
      expect(cacheControl, `"${hashedAssetPath}" must be cached forever`).toContain('immutable');
      expect(cacheControl).toContain('max-age=31536000');
    }
  });

  it('never caches index.html or wasm/* as immutable (fixed filenames, must revalidate)', () => {
    for (const fixedNamePath of ['/index.html', '/wasm/board_renderer_bg.wasm']) {
      const cacheControl = effectiveHeaderValues(fixedNamePath, 'Cache-Control').join(', ');
      expect(
        cacheControl,
        `"${fixedNamePath}" has a fixed filename — an immutable Cache-Control would mask a deploy (stale index.html) or pin an old renderer (stale wasm). See README.md.`,
      ).not.toContain('immutable');
    }
  });
});
