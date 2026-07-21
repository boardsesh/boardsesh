import { describe, it, expect } from 'vitest';
import { createOgBackgroundBuffer, getBackgroundRelPaths, toWebpPath } from '../background';

describe('toWebpPath', () => {
  it('rewrites a .png filename to .webp under the given dir', () => {
    expect(toWebpPath('images/kilter', 'product_sizes_layouts_sets/36-1.png', false)).toBe(
      'images/kilter/product_sizes_layouts_sets/36-1.webp',
    );
  });

  it('inserts /thumbs/ before the filename for thumbnails', () => {
    expect(toWebpPath('images/kilter', 'product_sizes_layouts_sets/36-1.png', true)).toBe(
      'images/kilter/product_sizes_layouts_sets/thumbs/36-1.webp',
    );
  });

  it('inserts thumbs at the top level when the filename has no directory', () => {
    expect(toWebpPath('images/moonboard', 'background.png', true)).toBe('images/moonboard/thumbs/background.webp');
  });
});

describe('getBackgroundRelPaths', () => {
  it('builds Aurora paths from images_to_holds keys', () => {
    const paths = getBackgroundRelPaths(
      {
        board_name: 'kilter',
        images_to_holds: { 'product_sizes_layouts_sets/36-1.png': [], 'product_sizes_layouts_sets/36-20.png': [] },
      },
      false,
    );
    expect(paths).toEqual([
      'images/kilter/product_sizes_layouts_sets/36-1.webp',
      'images/kilter/product_sizes_layouts_sets/36-20.webp',
    ]);
  });

  it('builds thumbnail Aurora paths', () => {
    const paths = getBackgroundRelPaths({ board_name: 'tension', images_to_holds: { 'a/1.png': [] } }, true);
    expect(paths).toEqual(['images/tension/a/thumbs/1.webp']);
  });

  it('falls back to layoutFolder + holdSetImages when images_to_holds is empty (MoonBoard)', () => {
    const paths = getBackgroundRelPaths(
      {
        board_name: 'moonboard',
        images_to_holds: {},
        layoutFolder: 'moonboard2024',
        holdSetImages: ['holdsetd.png', 'holdsete.png'],
      },
      false,
    );
    // First entry is the layout's background image, then each hold-set image.
    expect(paths).toHaveLength(3);
    expect(paths[0]).toMatch(/^images\/moonboard\/.+\.webp$/);
    expect(paths[1]).toBe('images/moonboard/moonboard2024/holdsetd.webp');
    expect(paths[2]).toBe('images/moonboard/moonboard2024/holdsete.webp');
  });

  it('returns an empty list when there are no keys and no MoonBoard fallback', () => {
    expect(getBackgroundRelPaths({ board_name: 'kilter', images_to_holds: {} }, false)).toEqual([]);
  });
});

describe('createOgBackgroundBuffer', () => {
  it('emits a deterministic 1200x630 SVG for the same board dimensions', () => {
    const first = createOgBackgroundBuffer(900, 500).toString('utf8');
    const second = createOgBackgroundBuffer(900, 500).toString('utf8');
    expect(first).toBe(second);
    expect(first).toContain('width="1200" height="630"');
  });

  it('centres the framed board region', () => {
    const svg = createOgBackgroundBuffer(800, 400).toString('utf8');
    // board 800 wide on a 1200 canvas → boardX = 200, frameX = 184.
    expect(svg).toContain('x="184"');
  });
});
