import { describe, it, expect, vi, afterEach } from 'vite-plus/test';
import { BOARD_RENDER_VERSION } from '@boardsesh/board-render/version';
import { STATIC_ASSET_MANIFEST } from '@boardsesh/static-assets';
import { getImageUrl, buildBoardRenderUrl, buildOverlayUrl, buildOgBoardRenderUrl } from '../util';
import type { BoardDetails } from '@/app/lib/types';

describe('getImageUrl', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe('self-hosted board images (relative paths)', () => {
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

    it('uses the immutable CDN object when the production asset origin is configured', () => {
      vi.stubEnv('NEXT_PUBLIC_STATIC_ASSET_BASE_URL', 'https://assets.boardsesh.com');
      const logicalPath = '/images/kilter/product_sizes_layouts_sets/36-1.webp';

      expect(getImageUrl('product_sizes_layouts_sets/36-1.png', 'kilter')).toBe(
        `https://assets.boardsesh.com/${STATIC_ASSET_MANIFEST[logicalPath]?.objectKey}`,
      );
    });

    // The Woods renderer feeds this the bare background key from
    // `getWoodsBoardDetails().images_to_holds` — the same three variants ship
    // under public/images/woods/ as for every other board.
    it('builds the Woods background href from the bare .png key', () => {
      expect(getImageUrl('woods-8x10-bg.png', 'woods')).toBe('/images/woods/woods-8x10-bg.webp');
    });

    it('inserts /thumbs/ for a Woods thumbnail', () => {
      expect(getImageUrl('woods-12x12-bg.png', 'woods', true)).toBe('/images/woods/thumbs/woods-12x12-bg.webp');
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

  it('unions a delta frame onto the frame it deltas from', () => {
    // Aurora delta format: `p1r12` then `,"p2r13` adds hold 2 on frame 1.
    // The `"` is what marks the frame as a delta — a later frame without it
    // is an absolute snapshot (issue #3947). Renderer can't parse commas —
    // toFlatFrames collapses and re-emits using STATE_TO_PRIMARY_CODE
    // ['kilter'] (12 -> 42, 13 -> 43).
    const url = buildOverlayUrl(boardDetails, 'p1r12,"p2r13');
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

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('points at the backend /og/climb endpoint as an absolute JPEG URL when the origin resolves', () => {
    vi.stubEnv('NEXT_PUBLIC_WS_URL', 'wss://ws.boardsesh.com/graphql');

    // `,"` marks frame 1 as a delta on frame 0 — a later frame without the
    // quote would be an absolute snapshot instead (issue #3947).
    const url = buildOgBoardRenderUrl(boardDetails, 'p1r12,"p2r13');

    expect(url).toBe(
      'https://ws.boardsesh.com/og/climb?board_name=kilter&layout_id=1&size_id=7&set_ids=1%2C20' +
        '&frames=p1r42p2r43&format=jpeg',
    );
  });

  it('falls back to the relative web board-render PNG URL when the backend origin is unset', () => {
    vi.stubEnv('NEXT_PUBLIC_WS_URL', '');

    const url = buildOgBoardRenderUrl(boardDetails, 'p1r12,p2r13');

    expect(url).toContain('/api/internal/board-render');
    expect(url).toContain('include_background=1');
    expect(url).toContain('variant=og');
    expect(url).toContain('format=png');
    expect(url).not.toContain('ws.boardsesh.com');
    expect(url).not.toContain('/api/og/climb');
    // The fallback goes through buildBoardRenderUrl, so it is versioned like
    // every other web producer.
    expect(url).toContain(`&v=${BOARD_RENDER_VERSION}`);
  });

  it('leaves the backend /og/climb URL unversioned', () => {
    vi.stubEnv('NEXT_PUBLIC_WS_URL', 'wss://ws.boardsesh.com/graphql');

    const url = buildOgBoardRenderUrl(boardDetails, 'p1r12');

    // Mobile builds this exact URL independently from a shipped binary
    // (packages/mobile/src/hooks/use-share-climb.ts), so a `v` on this side
    // alone would split the Cloudflare entry instead of versioning it.
    expect(url).not.toContain('v=');
  });
});

// #4773. Cloudflare does not purge on deploy, so a board-render URL that does
// not name its renderer version can be served stale for a year.
describe('board-render cache version', () => {
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

  it('is a lowercase hex digest the route will accept as well-formed', () => {
    // Same shape as `isWellFormedRenderVersion` in the route handler. If these
    // two ever disagree, every web URL silently drops to the bounded tier.
    expect(BOARD_RENDER_VERSION).toMatch(/^[0-9a-f]{12}$/);
    expect(BOARD_RENDER_VERSION).toMatch(/^[0-9a-f]{8,64}$/);
  });

  it.each([
    ['bare', {}],
    ['thumbnail', { thumbnail: true }],
    ['with background', { includeBackground: true }],
    ['og variant', { includeBackground: true, variant: 'og' as const, format: 'png' as const }],
    ['explicit format', { format: 'jpg' as const }],
  ])('appends the version on the %s path', (_label, options) => {
    expect(buildBoardRenderUrl(boardDetails, 'p1r12', options)).toContain(`&v=${BOARD_RENDER_VERSION}`);
  });

  it('appends the version through buildOverlayUrl', () => {
    expect(buildOverlayUrl(boardDetails, 'p1r12')).toContain(`&v=${BOARD_RENDER_VERSION}`);
    expect(buildOverlayUrl(boardDetails, 'p1r12', true)).toContain(`&v=${BOARD_RENDER_VERSION}`);
  });

  it('puts the version last so a log line reads as URL-then-version', () => {
    const url = buildBoardRenderUrl(boardDetails, 'p1r12', { thumbnail: true, includeBackground: true });
    expect(url.endsWith(`&v=${BOARD_RENDER_VERSION}`)).toBe(true);
  });
});
