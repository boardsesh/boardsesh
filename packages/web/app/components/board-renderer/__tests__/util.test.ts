import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { BOARD_FIELD_COLORS } from '@boardsesh/board-look';
import { BOARD_RENDER_VERSION } from '@boardsesh/board-render/version';
import { STATIC_ASSET_OBJECT_KEYS } from '@boardsesh/static-assets';
import {
  getImageUrl,
  toDarkArtUrl,
  hasDarkBoardArt,
  hasSplitDarkBoardArt,
  boardArtColorScheme,
  buildOverlayPreloadUrls,
  BOARDS_WITH_DARK_ART,
  BOARDS_WITH_SPLIT_DARK_ART,
  buildBoardArtLayers,
  buildBoardRenderUrl,
  buildOverlayUrl,
  buildOgBoardRenderUrl,
  buildSprayOgImageUrl,
} from '../util';
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
        `https://assets.boardsesh.com/${STATIC_ASSET_OBJECT_KEYS[logicalPath]}`,
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

  describe('toDarkArtUrl', () => {
    it('appends .dark before the extension', () => {
      expect(toDarkArtUrl('/images/woods/woods-8x10-bg.webp')).toBe('/images/woods/woods-8x10-bg.dark.webp');
    });

    it('composes with a thumbnail path', () => {
      expect(toDarkArtUrl(getImageUrl('woods-12x12-bg.png', 'woods', true))).toBe(
        '/images/woods/thumbs/woods-12x12-bg.dark.webp',
      );
    });

    it('leaves a path that is not .webp alone', () => {
      // Guards the ordering: getImageUrl rewrites .png → .webp first, so a caller that
      // reverses the two would silently ask for art that was never generated.
      expect(toDarkArtUrl('/images/woods/woods-8x10-bg.png')).toBe('/images/woods/woods-8x10-bg.png');
    });
  });

  describe('buildOverlayPreloadUrls', () => {
    const boardDetails = (board_name: string) =>
      ({
        board_name,
        layout_id: 1,
        size_id: 1,
        set_ids: [1],
        images_to_holds: { 'woods-8x10-bg.png': [] },
        boardWidth: 720,
        boardHeight: 1000,
      }) as never;

    it('preloads one image for a board with no dark art', () => {
      expect(buildOverlayPreloadUrls(boardDetails('kilter'), 'p1r42')).toHaveLength(1);
    });

    it('preloads the single overlay plus both photo layers for a themed board', () => {
      // A themed board draws photo + overlay stacked, so all of it is the LCP element. There
      // is still only ONE per-climb render in the list — the rest are static files.
      const urls = buildOverlayPreloadUrls(boardDetails('woods'), 'p1r42');

      expect(urls.filter((url) => url.includes('board-render'))).toHaveLength(1);
      expect(urls).toContain('/images/woods/woods-8x10-bg.webp');
      expect(urls).toContain('/images/woods/woods-8x10-bg.dark.webp');
    });

    it('asks the server for dark art on a board whose layers only partly have it', () => {
      // MoonBoard: one composite, dark per layer on the server, no static files that could 404.
      const urls = buildOverlayPreloadUrls(boardDetails('moonboard'), 'p1r42');

      expect(urls).toHaveLength(1);
      expect(new URL(urls[0], 'https://www.boardsesh.com').searchParams.get('color_scheme')).toBe('dark');
    });

    it('preloads nothing when the climb has no frames', () => {
      expect(buildOverlayPreloadUrls(boardDetails('woods'), null)).toEqual([]);
      expect(buildOverlayPreloadUrls(boardDetails('woods'), '')).toEqual([]);
    });
  });

  describe('hasDarkBoardArt', () => {
    it('is MoonBoard and Woods', () => {
      // The gate that keeps every other board on its existing render URL — asking for
      // `color_scheme=dark` there would re-render identical bytes under a new cache key.
      expect(hasDarkBoardArt('moonboard')).toBe(true);
      expect(hasDarkBoardArt('woods')).toBe(true);
      for (const board of ['kilter', 'tension', 'decoy'] as const) {
        expect(hasDarkBoardArt(board as never)).toBe(false);
        expect(boardArtColorScheme(board as never)).toBeUndefined();
      }
      expect(boardArtColorScheme('moonboard')).toBe('dark');
    });

    it('splits only Woods into static light/dark files', () => {
      // MoonBoard only has dark copies of some layers; asking the CDN for the rest 404s.
      expect(hasSplitDarkBoardArt('woods')).toBe(true);
      expect(hasSplitDarkBoardArt('moonboard')).toBe(false);
    });

    // Web resolves these paths by URL, so unlike mobile — which falls back when a key is
    // absent from its bundle manifest — a deleted or renamed dark file is a silent 404 for
    // every dark-mode reader. Walk what the gate claims and check the bytes are really there.
    const IMAGES_DIR = path.resolve(import.meta.dirname, '../../../../public/images');

    const lightWebpPaths = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const entryPath = path.join(dir, entry.name);
        if (entry.isDirectory()) return lightWebpPaths(entryPath);
        if (!entry.name.endsWith('.webp') || entry.name.endsWith('.dark.webp')) return [];
        return [entryPath];
      });

    it('lists every board whose image directory ships dark art', () => {
      // A board the generators add `.dark.webp` files for stays light on www until it is in
      // the gate. The app needs no list (it reads its bundle), so this is what keeps the two
      // from drifting apart again.
      const hasDarkFile = (dir: string): boolean =>
        readdirSync(dir, { withFileTypes: true }).some((entry) =>
          entry.isDirectory() ? hasDarkFile(path.join(dir, entry.name)) : entry.name.endsWith('.dark.webp'),
        );
      const boardsWithDarkFiles = readdirSync(IMAGES_DIR, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && hasDarkFile(path.join(IMAGES_DIR, entry.name)))
        .map((entry) => entry.name)
        .sort();

      expect(boardsWithDarkFiles).toEqual([...BOARDS_WITH_DARK_ART].sort());
    });

    for (const board of BOARDS_WITH_SPLIT_DARK_ART) {
      it(`${board} has a committed dark sibling for every one of its light images`, () => {
        const boardDir = path.join(IMAGES_DIR, board);
        expect(existsSync(boardDir)).toBe(true);

        const lightPaths = lightWebpPaths(boardDir);
        expect(lightPaths.length).toBeGreaterThan(0);

        const missing = lightPaths.filter((lightPath) => !existsSync(toDarkArtUrl(lightPath)));
        expect(missing.map((absolute) => path.relative(IMAGES_DIR, absolute))).toEqual([]);
      });
    }
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

  beforeEach(() => {
    vi.stubEnv('NEXT_PUBLIC_WS_URL', 'wss://ws.boardsesh.com/graphql');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('builds a correctly structured Railway URL', () => {
    // Single-frame strings pass through verbatim (no commas, no `x` tokens).
    const url = buildOverlayUrl(boardDetails, 'p1r12p2r13');
    expect(url).toContain('https://ws.boardsesh.com/render/board');
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

  it('names the drawing in both directions, never leaving it to the endpoint', () => {
    // Omitting the param used to mean classic and now means aura, so a caller
    // that deliberately asks for classic has to say so — otherwise it gets an
    // aura render, and a `<img>` fallback would disagree with the canvas beside
    // it. Sending it either way also gives each drawing its own Cloudflare
    // entry, which is what makes the flip safe under an immutable header.
    const aura = buildOverlayUrl(boardDetails, 'p1r12');
    expect(aura).toContain('render_mode=aura');
    expect(aura).toContain('field_color=%23181225');

    // Naming it explicitly reaches the same URL as taking the default.
    expect(buildBoardRenderUrl(boardDetails, 'p1r12', { includeBackground: true, renderMode: 'aura' })).toBe(aura);

    const classic = buildOverlayUrl(boardDetails, 'p1r12', undefined, undefined, 'classic');
    expect(classic).toContain('render_mode=classic');
    expect(classic).not.toContain('render_mode=aura');
    expect(classic).not.toContain('field_color');
  });

  it('preserves the existing dark-field URL when no field override is supplied', () => {
    const options = { thumbnail: true, includeBackground: true, format: 'png' as const, colorScheme: 'dark' as const };
    const url = buildBoardRenderUrl(boardDetails, 'p1r12,p2r13', options);

    expect(url).toBe(
      'https://ws.boardsesh.com/render/board?board_name=kilter&layout_id=1&size_id=7&set_ids=1,20' +
        '&frames=p1r12%2Cp2r13&thumbnail=1&include_background=1&format=png&color_scheme=dark' +
        `&render_mode=aura&field_color=%23181225&v=${BOARD_RENDER_VERSION}`,
    );
    expect(buildBoardRenderUrl(boardDetails, 'p1r12,p2r13', { ...options, fieldColor: BOARD_FIELD_COLORS.dark })).toBe(
      url,
    );
  });

  it('gives a white Aura field its own encoded cache URL without a fragment', () => {
    const dark = buildBoardRenderUrl(boardDetails, 'p1r12', { includeBackground: true });
    const light = buildBoardRenderUrl(boardDetails, 'p1r12', {
      includeBackground: true,
      fieldColor: BOARD_FIELD_COLORS.light,
    });
    const parsedLight = new URL(light);

    expect(light).not.toBe(dark);
    expect(light.replace('field_color=%23FFFFFF', 'field_color=%23181225')).toBe(dark);
    expect(parsedLight.searchParams.getAll('field_color')).toEqual([BOARD_FIELD_COLORS.light]);
    expect(parsedLight.hash).toBe('');
    expect(light.endsWith(`&v=${BOARD_RENDER_VERSION}`)).toBe(true);
  });

  it.each(['light', 'dark'] as const)(
    'keeps the %s board-art selection independent of the Aura field',
    (colorScheme) => {
      const url = buildBoardRenderUrl(boardDetails, 'p1r12', { colorScheme, fieldColor: BOARD_FIELD_COLORS.light });
      const params = new URL(url).searchParams;

      expect(params.get('field_color')).toBe(BOARD_FIELD_COLORS.light);
      expect(params.get('color_scheme')).toBe(colorScheme === 'dark' ? 'dark' : null);
    },
  );

  it('ignores the Aura field override for classic drawing', () => {
    const options = { includeBackground: true, colorScheme: 'dark' as const, renderMode: 'classic' as const };
    const classic = buildBoardRenderUrl(boardDetails, 'p1r12', options);

    expect(buildBoardRenderUrl(boardDetails, 'p1r12', { ...options, fieldColor: BOARD_FIELD_COLORS.light })).toBe(
      classic,
    );
    expect(new URL(classic).searchParams.has('field_color')).toBe(false);
  });

  it('threads the drawing through the layered art builder', () => {
    // `BoardImageLayers` builds its overlay through here, so a mode that stopped
    // at the component boundary would leave the fallback drawing classic.
    expect(buildBoardArtLayers(boardDetails, 'p1r12', false, 'aura').overlayUrl).toContain('render_mode=aura');
    expect(buildBoardArtLayers(boardDetails, 'p1r12', false, 'classic').overlayUrl).toContain('render_mode=classic');
  });

  it.each(['', 'ws://localhost:8080/graphql', 'ws://127.0.0.1:8080/graphql'])(
    'keeps the same-origin compatibility path for local backend %j',
    (configuredWsUrl) => {
      vi.stubEnv('NEXT_PUBLIC_WS_URL', configuredWsUrl);

      expect(buildOverlayUrl(boardDetails, 'p1r12')).toContain('/api/internal/board-render');
    },
  );

  it('keeps the same-origin path in Tailscale development', () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('NEXT_PUBLIC_WS_URL', 'wss://vibetunnel-dev-1.example.ts.net:8081/graphql');

    expect(buildOverlayUrl(boardDetails, 'p1r12')).toContain('/api/internal/board-render');
  });
});

describe('buildBoardArtLayers dark art', () => {
  const details = (board_name: string, images: string[]) =>
    ({
      board_name,
      layout_id: 2,
      size_id: 1,
      set_ids: [2, 3],
      images_to_holds: Object.fromEntries(images.map((image) => [image, []])),
      boardWidth: 650,
      boardHeight: 1000,
    }) as never;
  const moonboard = details('moonboard', [
    '/images/moonboard/moonboard-bg.png',
    '/images/moonboard/moonboardmasters2019/holdseta.png',
    '/images/moonboard/moonboardmasters2019/holdsetb.png',
  ]);
  const colorSchemeOf = (url: string | null) =>
    url === null ? null : new URL(url, 'https://www.boardsesh.com').searchParams.get('color_scheme');

  it('draws a MoonBoard climb as one composite with the dark art resolved by the server', () => {
    // The black set B holds and the A-K / 1-18 labels vanish on the dark field otherwise. The
    // server swaps in the `.dark.webp` layers that exist and keeps set A light, the same rule
    // the app applies to its bundle.
    const { backgroundUrls, overlayUrl } = buildBoardArtLayers(moonboard, 'p1r12', true);

    expect(backgroundUrls).toEqual([]);
    expect(overlayUrl).toContain('include_background=1');
    expect(colorSchemeOf(overlayUrl)).toBe('dark');
  });

  it('draws a bare MoonBoard through the same composite instead of the light files', () => {
    for (const frames of [null, undefined, '']) {
      const { backgroundUrls, overlayUrl } = buildBoardArtLayers(moonboard, frames, true);

      expect(backgroundUrls).toEqual([]);
      expect(colorSchemeOf(overlayUrl)).toBe('dark');
    }
  });

  it('leaves boards with no dark art on the URL they always had', () => {
    const kilter = details('kilter', ['product_sizes_layouts_sets/36-1.png']);

    expect(colorSchemeOf(buildBoardArtLayers(kilter, 'p1r12', true).overlayUrl)).toBeNull();
    expect(buildBoardArtLayers(kilter, null, true).overlayUrl).toBeNull();
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

    // `render_mode` and `field_color` are named rather than left to the
    // endpoint default on purpose: the params ARE the Cloudflare key, and a card
    // is cached `immutable` for a year, so a bare URL already sitting at the
    // edge could not be re-drawn in place. `use-share-climb.ts` in the app
    // builds the same pair for its prewarm — if the two ever disagree, the app
    // heats an entry no crawler asks for.
    expect(url).toBe(
      'https://ws.boardsesh.com/og/climb?board_name=kilter&layout_id=1&size_id=7&set_ids=1%2C20' +
        `&frames=p1r42p2r43&format=jpeg&render_mode=aura&field_color=%23181225&v=${BOARD_RENDER_VERSION}`,
    );
  });

  it('washes toward the same field the renderer measures against', () => {
    // The coupling that matters is not web-to-mobile, it is either side to the
    // shared constant: `buildOgBoardRenderUrl` and `use-share-climb.ts` both
    // read `BOARD_FIELD_COLORS.dark`, so neither can drift from the value the
    // veil is bucketed against. Asserted against the constant rather than the
    // literal so this fails if web ever stops reading it — which is the only
    // way the app's prewarm could start warming an entry no crawler requests.
    vi.stubEnv('NEXT_PUBLIC_WS_URL', 'wss://ws.boardsesh.com/graphql');

    expect(buildOgBoardRenderUrl(boardDetails, 'p1r12')).toContain(
      `field_color=${encodeURIComponent(BOARD_FIELD_COLORS.dark)}`,
    );
    expect(buildOverlayUrl(boardDetails, 'p1r12')).toContain(
      `field_color=${encodeURIComponent(BOARD_FIELD_COLORS.dark)}`,
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

  it('versions the backend card after its identity so changed drawings bypass immutable CDN copies', () => {
    vi.stubEnv('NEXT_PUBLIC_WS_URL', 'wss://ws.boardsesh.com/graphql');

    const url = buildOgBoardRenderUrl(boardDetails, 'p1r12', { name: 'A climb', grade: '6a' });

    expect(url).toContain('n=A+climb&g=6a');
    expect(url.endsWith(`&v=${BOARD_RENDER_VERSION}`)).toBe(true);
  });
});

describe('buildSprayOgImageUrl', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('versions the public spray card in the same parameter order as mobile prewarming', () => {
    vi.stubEnv('NEXT_PUBLIC_WS_URL', 'wss://ws.boardsesh.com/graphql');

    expect(buildSprayOgImageUrl(4321, 'p12r42p19r43')).toBe(
      `https://ws.boardsesh.com/og/climb?board_name=spray&layout_id=4321&size_id=4321&set_ids=1&frames=p12r42p19r43&format=jpeg&v=${BOARD_RENDER_VERSION}`,
    );
  });

  it('does not advertise a card without a backend or climb frames', () => {
    vi.stubEnv('NEXT_PUBLIC_WS_URL', '');
    expect(buildSprayOgImageUrl(4321, 'p12r42')).toBeNull();
    vi.stubEnv('NEXT_PUBLIC_WS_URL', 'wss://ws.boardsesh.com/graphql');
    expect(buildSprayOgImageUrl(4321, '')).toBeNull();
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

  beforeEach(() => {
    vi.stubEnv('NEXT_PUBLIC_WS_URL', 'wss://ws.boardsesh.com/graphql');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

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

describe('buildOgBoardRenderUrl grade guard', () => {
  beforeEach(() => {
    vi.stubEnv('NEXT_PUBLIC_WS_URL', 'wss://ws.boardsesh.com/graphql');
  });

  it('drops a grade the card renderer would reject', () => {
    // A grade that fails the server's pattern is a 400, and a 400 is no card at
    // all. An unrecognised grade has to cost the grade, never the image.
    const boardDetails = { board_name: 'kilter', layout_id: 1, size_id: 10, set_ids: [1, 20] } as never;
    const url = buildOgBoardRenderUrl(boardDetails, 'p1080r15', { name: 'Boulder 9', grade: 'カチ' });

    expect(url).toContain('n=Boulder');
    expect(url).not.toContain('g=');
  });

  it('keeps every grade vocabulary we actually render', () => {
    const boardDetails = { board_name: 'kilter', layout_id: 1, size_id: 10, set_ids: [1, 20] } as never;

    for (const grade of ['V7', '7B+', '6c+', '5.12a', 'V8/7B', '7a/V6']) {
      expect(buildOgBoardRenderUrl(boardDetails, 'p1080r15', { grade }), grade).toContain('g=');
    }
  });
});
