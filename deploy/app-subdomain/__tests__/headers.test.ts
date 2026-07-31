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
