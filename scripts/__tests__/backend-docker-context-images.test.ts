import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The backend image carries the board photos because `GET /og/climb` composites
 * them onto the share card. Every photo is committed twice — a `.png` and the
 * `.webp` that `packages/web/scripts/convert-to-webp.sh` makes from it — and the
 * renderer only ever opens the WebP, so the PNGs were 52 MB of a 74 MB tree
 * pulled on every deploy and never read.
 *
 * `board-art-is-webp.test.ts` guards the other half: that no catalogue path ever
 * asks for a raster this exclusion leaves behind.
 */
describe('backend Docker context', () => {
  const script = readFileSync(resolve(process.cwd(), 'scripts/create-service-docker-context.mjs'), 'utf8');
  const backendStart = script.indexOf('  backend: {');
  const backendEnd = script.indexOf('  web: {', backendStart);
  const backendBlock = script.slice(backendStart, backendEnd);

  // Asserted before anything reads the slice. Both ends are located by an
  // indexOf on literal source text, so a rename or a reindent of the SERVICES
  // map makes the slice empty — and every `toContain` below would then fail
  // with "expected '' to contain ...", which reads as the exclusion having been
  // deleted rather than as this test having lost its footing.
  it('finds the backend service block it reads', () => {
    expect(backendStart, 'the SERVICES map no longer spells the backend entry this way').toBeGreaterThan(-1);
    expect(backendEnd, 'the web entry no longer follows the backend entry').toBeGreaterThan(backendStart);
  });

  it('still ships the board images tree', () => {
    expect(backendBlock).toContain("extraSourceDirs: ['packages/web/public/images']");
  });

  it('leaves the PNG originals out of it', () => {
    expect(backendBlock).toContain("extraSourceDirExcludeExtensions: ['.png']");
  });

  it('keeps the exclusion scoped to the service that asked for it', () => {
    // Declared once, by the backend. A second service opting in — the web image
    // serves icon PNGs — would be a silent 404 rather than a build failure.
    const declarations = script.match(/extraSourceDirExcludeExtensions:/g) ?? [];

    expect(declarations).toHaveLength(1);
    expect(backendBlock).toContain('extraSourceDirExcludeExtensions:');
  });

  it('threads the filter through the recursive descent', () => {
    // The tree is `images/<board>/<layout>/…`, so a filter that only ran on the
    // first level would exclude nothing at all.
    //
    // Asserted on the RECURSIVE CALL specifically, inside the function body: a
    // looser match is satisfied by the parameter list of the definition itself,
    // and would pass while the recursion quietly dropped the argument — the
    // exact failure this is here to catch.
    const body = script.slice(script.indexOf('function copyDirectory('));
    const recursiveCall = /copyDirectory\(sourcePath,[^)]*\)/.exec(body.slice(body.indexOf('{')));

    expect(recursiveCall, 'copyDirectory no longer recurses the way this test reads it').not.toBeNull();
    expect(recursiveCall?.[0]).toContain('excludeExtensions');
  });

  it('passes the filter to the skip predicate rather than only accepting it', () => {
    expect(script).toMatch(/shouldSkipSourceEntry\([^)]*excludeExtensions/);
  });
});
