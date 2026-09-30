import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SHOWCASE_FPS } from '../lib/showcase-video/contract';
import { SHOWCASE_TOTAL_FRAMES } from '../lib/showcase-video/timeline';

/**
 * The homepage's VideoObject JSON-LD carries the video's length as a literal in
 * `packages/web/app/lib/showcase-video.ts`. Nothing under packages/web may
 * import repo-root `scripts/` (the web Docker image doesn't contain it), so the
 * drift check lives here and reads that file as text.
 */
describe('showcase video web duration', () => {
  it('declares a JSON-LD duration equal to the timeline length', () => {
    const source = readFileSync(resolve(import.meta.dirname, '../../packages/web/app/lib/showcase-video.ts'), 'utf8');
    const match = source.match(/duration:\s*'PT([\d.]+)S'/);
    expect(match, 'no PT…S duration found in packages/web/app/lib/showcase-video.ts').not.toBeNull();
    expect(Number(match?.[1])).toBe(Number((SHOWCASE_TOTAL_FRAMES / SHOWCASE_FPS).toFixed(1)));
  });
});
