import { describe, it, expect } from 'vite-plus/test';
import { getImageUrl, buildBoardRenderUrl, buildOverlayUrl, buildOgBoardRenderUrl } from '../util';
import type { BoardDetails } from '@/app/lib/types';

describe('getImageUrl', () => {
  describe('self-hosted Kilter/Tension images (relative paths)', () => {
    it('converts PNG to WebP', () => {
      expect(getImageUrl('product_sizes_layouts_sets/36-1.png', 'kilter')).toBe(
        '/images/kilter/product_sizes_layouts_sets/36-1.webp',
      );
    });

    it('returns WebP path unchanged if already .webp', () => {
      expect(getImageUrl('product_sizes_layouts_sets/36-1.webp', 'kilter')).toBe(
        '/images/kilter/product_sizes_layouts_sets/36-1.webp',
      );
    });

    it('inserts /thumbs/ for thumbnail=true', () => {
      expect(getImageUrl('product_sizes_layouts_sets/36-1.png', 'kilter', true)).toBe(
        '/images/kilter/product_sizes_layouts_sets/thumbs/36-1.webp',
      );
    });

    it('works for tension board', () => {
      expect(getImageUrl('product_sizes_layouts_sets/1.png', 'tension', true)).toBe(
        '/images/tension/product_sizes_layouts_sets/thumbs/1.webp',
      );
    });
  });

  describe('absolute paths (MoonBoard images starting with /)', () => {
    it('converts PNG to WebP for full-size', () => {
      expect(getImageUrl('/images/moonboard/moonboard-bg.png', 'moonboard' as never)).toBe(
        '/images/moonboard/moonboard-bg.webp',
      );
    });

    it('passes through already-.webp absolute URL', () => {
      expect(getImageUrl('/images/moonboard/moonboard-bg.webp', 'moonboard' as never)).toBe(
        '/images/moonboard/moonboard-bg.webp',
      );
    });

    it('inserts /thumbs/ for thumbnail=true', () => {
      expect(getImageUrl('/images/moonboard/moonboard-bg.png', 'moonboard' as never, true)).toBe(
        '/images/moonboard/thumbs/moonboard-bg.webp',
      );
    });

    it('inserts /thumbs/ correctly for nested MoonBoard layout paths', () => {
      expect(getImageUrl('/images/moonboard/moonboard2024/holdsete.png', 'moonboard' as never, true)).toBe(
        '/images/moonboard/moonboard2024/thumbs/holdsete.webp',
      );
    });

    it('inserts /thumbs/ for already-.webp absolute URL with thumbnail=true', () => {
      expect(getImageUrl('/images/moonboard/moonboard-bg.webp', 'moonboard' as never, true)).toBe(
        '/images/moonboard/thumbs/moonboard-bg.webp',
      );
    });
  });
});

describe('buildOverlayUrl', () => {
  const boardDetails: BoardDetails = {
    board_name: 'kilter',
    layout_id: 1,
    size_id: 7,
    set_ids: [1, 20],
    images_to_holds: {},
    holdsData: [],
    edge_left: 0,
    edge_right: 144,
    edge_bottom: 0,
    edge_top: 180,
    boardWidth: 1080,
    boardHeight: 1350,
  } as unknown as BoardDetails;

  it('builds a correctly structured URL', () => {
    // Single-frame strings pass through verbatim (no commas, no `x` tokens).
    const url = buildOverlayUrl(boardDetails, 'p1r12p2r13');
    expect(url).toContain('/api/internal/board-render');
    expect(url).toContain('board_name=kilter');
    expect(url).toContain('layout_id=1');
    expect(url).toContain('size_id=7');
    expect(url).toContain('set_ids=1,20');
    expect(url).toContain('frames=p1r12p2r13');
    expect(url).not.toContain('thumbnail');
  });

  it('collapses multi-frame delta strings to the cumulative final snapshot', () => {
    // Aurora delta format: `p1r12` then `,p2r13` adds hold 2 on frame 1.
    // Renderer can't parse commas — toFlatFrames accumulates and re-emits
    // using STATE_TO_PRIMARY_CODE['kilter'] (12 -> 42, 13 -> 43).
    const url = buildOverlayUrl(boardDetails, 'p1r12,p2r13');
    expect(url).toContain('frames=p1r42p2r43');
    expect(url).not.toContain('%2C');
  });

  it('appends thumbnail=1 when thumbnail is true', () => {
    const url = buildOverlayUrl(boardDetails, 'p1r12', true);
    expect(url).toContain('&thumbnail=1');
  });

  it('supports JPEG format in board render URLs', () => {
    const url = buildBoardRenderUrl(boardDetails, 'p1r12', {
      thumbnail: true,
      includeBackground: true,
      format: 'jpg',
    });

    expect(url).toContain('format=jpg');
  });

  it('omits thumbnail param when false', () => {
    const url = buildOverlayUrl(boardDetails, 'p1r12', false);
    expect(url).not.toContain('thumbnail');
  });
});

describe('buildOgBoardRenderUrl', () => {
  const boardDetails: BoardDetails = {
    board_name: 'kilter',
    layout_id: 1,
    size_id: 7,
    set_ids: [1, 20],
    images_to_holds: {},
    holdsData: [],
    edge_left: 0,
    edge_right: 144,
    edge_bottom: 0,
    edge_top: 180,
    boardWidth: 1080,
    boardHeight: 1350,
  } as unknown as BoardDetails;

  it('builds the public OG board render URL', () => {
    const url = buildOgBoardRenderUrl(boardDetails, 'p1r12,p2r13');

    expect(url).toContain('/api/internal/board-render');
    expect(url).toContain('include_background=1');
    expect(url).toContain('variant=og');
    expect(url).toContain('format=png');
    expect(url).not.toContain('/api/og/climb');
  });
});
