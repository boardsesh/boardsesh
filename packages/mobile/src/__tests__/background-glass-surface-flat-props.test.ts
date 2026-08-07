import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// GlassSurface's Material branch defaults to `shadows.sm` (elevation 2). A
// consumer that stacks its content as a SIBLING of the surface — rather than as
// a child — relies on Android's Z-ordering-by-elevation to keep that default
// from lifting the surface above its own content. `level="level0"` (flat) and
// `pointerEvents="none"` are what opt a background fill out of that footgun; the
// glass-surface.test.tsx suite pins GlassSurface's own contract for those props,
// but nothing else asserted that these specific call sites actually pass them —
// so a refactor could silently drop either prop and reintroduce #4209 with no
// test failing. This is a source-scan regression guard, not a render test: a
// full mount of any of these screens needs their surrounding provider tree
// (drawer-host / queue / theme), which is disproportionate for pinning two JSX
// attributes.
//
// Each fixture file is asserted to have exactly one `<GlassSurface` JSX usage
// (a background fill) so the extracted opening tag is unambiguous.
const BACKGROUND_GLASS_SURFACE_SITES = [
  join(__dirname, '../../app/play.tsx'),
  join(__dirname, '../../app/(tabs)/record/index.tsx'),
  join(__dirname, '../components/navigation/IpadSidebar.tsx'),
];

function backgroundGlassSurfaceOpeningTag(filePath: string): string {
  const source = readFileSync(filePath, 'utf8');
  const occurrences = [...source.matchAll(/<GlassSurface\b/g)];
  if (occurrences.length !== 1) {
    throw new Error(
      `Expected exactly one <GlassSurface usage in ${filePath}, found ${occurrences.length}. ` +
        'Update this test to disambiguate which one is the background fill.',
    );
  }
  const start = occurrences[0].index;
  const end = source.indexOf('/>', start);
  if (end === -1) {
    throw new Error(`Could not find the closing "/>" for <GlassSurface in ${filePath}`);
  }
  return source.slice(start, end + 2);
}

describe('background GlassSurface fills stay flat and non-interactive (#4209)', () => {
  for (const filePath of BACKGROUND_GLASS_SURFACE_SITES) {
    const relativePath = filePath.slice(filePath.indexOf('packages/mobile'));

    it(`${relativePath} passes level="level0"`, () => {
      expect(backgroundGlassSurfaceOpeningTag(filePath)).toMatch(/level="level0"/);
    });

    it(`${relativePath} passes pointerEvents="none"`, () => {
      expect(backgroundGlassSurfaceOpeningTag(filePath)).toMatch(/pointerEvents="none"/);
    });
  }
});
