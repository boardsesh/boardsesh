import { beforeEach, describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';
import {
  buildSprayOverlayMarks,
  buildSprayOverlaySvg,
  renderSprayOgCard,
  resetSprayOgCardCache,
  type SprayOgCardDeps,
  type SprayOgHold,
  type SprayOgWallRow,
} from '../services/spray-og-card';

// Spray role colours (HOLD_STATE_MAP.spray): 1 STARTING, 2 HAND, 3 FINISH.
const STARTING_COLOR = '#00DD00';
const HAND_COLOR = '#4444FF';
const FINISH_COLOR = '#FF0000';

async function makePhotoJpeg(width = 900, height = 1200): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: '#8b6f47' } })
    .jpeg()
    .toBuffer();
}

const publicWall: SprayOgWallRow = {
  wallId: 7,
  layoutId: 90001,
  wallName: 'Garage wall',
  isPublic: true,
  publicPhotoKey: 'spray-walls/abc/deadbeef.jpg',
  currentVersionId: 42,
};

const wallHolds: SprayOgHold[] = [
  { holdId: 501, cx: 200, cy: 300, r: 40, outline: null },
  { holdId: 502, cx: 400, cy: 700, r: 50, outline: [-1, -1, 1, -1, 1, 1, -1, 1] },
  { holdId: 503, cx: 600, cy: 1000, r: 45, outline: null },
];

function makeDeps(overrides: Partial<SprayOgCardDeps> = {}, photo?: Buffer): SprayOgCardDeps {
  return {
    loadWall: vi.fn(async () => publicWall),
    loadPublishedVersion: vi.fn(async () => ({ photoWidth: 900, photoHeight: 1200, homography: null })),
    loadAliveHolds: vi.fn(async () => wallHolds),
    fetchPhotoBytes: vi.fn(async () => photo ?? Buffer.alloc(0)),
    publicPhotoUrl: vi.fn((key: string) => `https://media.example/${key}`),
    ...overrides,
  };
}

/** Frames unique per test so the process-lifetime card cache cannot mask a change. */
let framesCounter = 0;
function uniqueFrames(body: string): string {
  framesCounter += 1;
  return `${body}p99${framesCounter}r2`;
}

describe('renderSprayOgCard — the visibility gate', () => {
  beforeEach(() => {
    resetSprayOgCardCache();
  });

  it('renders a card for a public, published wall with a public photo key', async () => {
    const photo = await makePhotoJpeg();
    const deps = makeDeps({}, photo);

    const result = await renderSprayOgCard(
      { layoutId: publicWall.layoutId, frames: 'p501r1p502r2', format: 'jpeg' },
      deps,
    );

    expect(result.kind).toBe('card');
    if (result.kind !== 'card') return;
    expect(result.contentType).toBe('image/jpeg');
    const metadata = await sharp(result.buffer).metadata();
    expect(metadata.format).toBe('jpeg');
    expect(metadata.width).toBe(1200);
    expect(metadata.height).toBe(630);
    expect(deps.fetchPhotoBytes).toHaveBeenCalledTimes(1);
  });

  it('honours png and webp', async () => {
    const photo = await makePhotoJpeg();
    for (const [format, expectedType] of [
      ['png', 'image/png'],
      ['webp', 'image/webp'],
    ] as const) {
      const result = await renderSprayOgCard(
        { layoutId: publicWall.layoutId, frames: uniqueFrames('p501r1'), format },
        makeDeps({}, photo),
      );
      expect(result.kind).toBe('card');
      if (result.kind !== 'card') continue;
      expect(result.contentType).toBe(expectedType);
      expect((await sharp(result.buffer).metadata()).format).toBe(format);
    }
  });

  // Every one of these answers the SAME not-found, and none of them may touch a
  // photo: a card that distinguished "no such wall" from "a wall you may not
  // see" would enumerate somebody's home wall from a sequential layout id.
  const closedGates: { name: string; overrides: Partial<SprayOgCardDeps> }[] = [
    { name: 'no wall at that layout id', overrides: { loadWall: vi.fn(async () => null) } },
    {
      name: 'a private wall',
      overrides: { loadWall: vi.fn(async () => ({ ...publicWall, isPublic: false })) },
    },
    {
      name: 'an unlisted-but-not-public wall',
      overrides: { loadWall: vi.fn(async () => ({ ...publicWall, isPublic: false, publicPhotoKey: null })) },
    },
    {
      name: 'a wall that has never published a version',
      overrides: { loadWall: vi.fn(async () => ({ ...publicWall, currentVersionId: null })) },
    },
    {
      name: 'a public wall with no public photo key',
      overrides: { loadWall: vi.fn(async () => ({ ...publicWall, publicPhotoKey: null })) },
    },
    {
      name: 'a media bucket that is not configured',
      overrides: { publicPhotoUrl: vi.fn(() => null) },
    },
    {
      name: 'a published version row that has gone',
      overrides: { loadPublishedVersion: vi.fn(async () => null) },
    },
  ];

  for (const gate of closedGates) {
    it(`answers not-found without reading a photo: ${gate.name}`, async () => {
      const deps = makeDeps(gate.overrides, await makePhotoJpeg());
      const result = await renderSprayOgCard(
        { layoutId: publicWall.layoutId, frames: uniqueFrames('p501r1'), format: 'jpeg' },
        deps,
      );
      // The leak is asserted BEFORE the status code: a gate that fell through
      // would fail on "kind" first and never prove the photo stayed unread.
      expect(deps.fetchPhotoBytes).not.toHaveBeenCalled();
      expect(result.kind).toBe('not-found');
    });
  }

  it('never even derives a photo URL for a private wall', async () => {
    const deps = makeDeps({ loadWall: vi.fn(async () => ({ ...publicWall, isPublic: false })) }, await makePhotoJpeg());
    const result = await renderSprayOgCard(
      { layoutId: publicWall.layoutId, frames: uniqueFrames('p501r1'), format: 'jpeg' },
      deps,
    );
    expect(deps.fetchPhotoBytes).not.toHaveBeenCalled();
    expect(deps.publicPhotoUrl).not.toHaveBeenCalled();
    expect(result.kind).toBe('not-found');
  });

  it('degrades a singular homography to a photo-only card rather than throwing', async () => {
    // A matrix whose rows are linearly dependent has no inverse. `invert` throws
    // on it by design; a shared link must still resolve.
    const deps = makeDeps(
      {
        loadPublishedVersion: vi.fn(async () => ({
          photoWidth: 900,
          photoHeight: 1200,
          homography: [1, 2, 3, 2, 4, 6, 7, 8, 9],
        })),
      },
      await makePhotoJpeg(),
    );

    const result = await renderSprayOgCard(
      { layoutId: publicWall.layoutId, frames: uniqueFrames('p501r1p502r2'), format: 'jpeg' },
      deps,
    );

    expect(result.kind).toBe('card');
    if (result.kind !== 'card') return;
    const metadata = await sharp(result.buffer).metadata();
    expect(metadata.width).toBe(1200);
    expect(metadata.height).toBe(630);
  });

  it('serves a repeat request from the in-process cache without re-fetching the photo', async () => {
    const photo = await makePhotoJpeg();
    const deps = makeDeps({}, photo);
    const frames = uniqueFrames('p501r1');

    const first = await renderSprayOgCard({ layoutId: publicWall.layoutId, frames, format: 'jpeg' }, deps);
    const second = await renderSprayOgCard({ layoutId: publicWall.layoutId, frames, format: 'jpeg' }, deps);

    expect(first.kind).toBe('card');
    expect(second.kind).toBe('card');
    expect(deps.fetchPhotoBytes).toHaveBeenCalledTimes(1);
  });

  it('does not serve one version’s bytes under another’s key', async () => {
    const photo = await makePhotoJpeg();
    const frames = uniqueFrames('p501r1');

    const deps = makeDeps({}, photo);
    await renderSprayOgCard({ layoutId: publicWall.layoutId, frames, format: 'jpeg' }, deps);

    // A reset publishes a new version and re-points the public copy.
    const afterReset = makeDeps(
      {
        loadWall: vi.fn(async () => ({
          ...publicWall,
          currentVersionId: 43,
          publicPhotoKey: 'spray-walls/abc/cafebabe.jpg',
        })),
      },
      photo,
    );
    await renderSprayOgCard({ layoutId: publicWall.layoutId, frames, format: 'jpeg' }, afterReset);
    expect(afterReset.fetchPhotoBytes).toHaveBeenCalledTimes(1);
  });
});

describe('buildSprayOverlayMarks / buildSprayOverlaySvg', () => {
  const identityMatrix = [1, 0, 0, 0, 1, 0, 0, 0, 1];

  it('draws one mark per LIT hold and nothing for an unlit one', () => {
    const marks = buildSprayOverlayMarks({
      holds: wallHolds,
      frames: 'p501r1p502r2',
      canonicalToPhoto: identityMatrix,
      photoToPlaced: 1,
    });

    expect(marks.map((mark) => mark.holdId)).toEqual([501, 502]);
    expect(marks.map((mark) => mark.color)).toEqual([STARTING_COLOR, HAND_COLOR]);
    // 503 is on the wall but not in the climb.
    expect(marks.some((mark) => mark.holdId === 503)).toBe(false);
  });

  it('draws a traced hold as a polygon, an untraced one as a circle, and an unlit one not at all', () => {
    // 501 has no outline, 502 has one, 503 is on the wall but not in the climb.
    const marks = buildSprayOverlayMarks({
      holds: wallHolds,
      frames: 'p501r1p502r2',
      canonicalToPhoto: identityMatrix,
      photoToPlaced: 1,
    });
    const svg = buildSprayOverlaySvg({ width: 900, height: 1200, marks });

    // Two elements per mark: the dark halo and the coloured mark on top.
    expect(svg.match(/<circle /g)).toHaveLength(2);
    expect(svg.match(/<polygon /g)).toHaveLength(2);
    expect(svg).toContain(`stroke="${STARTING_COLOR}"`);
    expect(svg).toContain(`stroke="${HAND_COLOR}"`);
    // The unlit hold contributes nothing at all — no mark, no colour.
    expect(svg).not.toContain('cx="600"');
    expect(svg).not.toContain(FINISH_COLOR);
  });

  it('carries the FINISH role colour when the climb lights a finish hold', () => {
    const marks = buildSprayOverlayMarks({
      holds: wallHolds,
      frames: 'p503r3',
      canonicalToPhoto: identityMatrix,
      photoToPlaced: 1,
    });
    const svg = buildSprayOverlaySvg({ width: 900, height: 1200, marks });
    expect(svg).toContain(`stroke="${FINISH_COLOR}"`);
    expect(svg).toContain('cx="600"');
  });

  it('places an outline point at centre + offset x radius, scaled into the placed photo', () => {
    const [mark] = buildSprayOverlayMarks({
      holds: [wallHolds[1]],
      frames: 'p502r2',
      canonicalToPhoto: identityMatrix,
      photoToPlaced: 0.5,
    });

    expect(mark.centerX).toBeCloseTo(200);
    expect(mark.centerY).toBeCloseTo(350);
    expect(mark.radius).toBeCloseTo(25);
    // First outline point (-1, -1) => (400 - 50, 700 - 50) => halved.
    expect(mark.points?.slice(0, 2)).toEqual([175, 325]);
  });

  it('keeps a hold with an unknown role code out of the SVG markup', () => {
    // An unknown role falls back to plain white in HOLD_STATE_MAP; whatever the
    // colour is, it has to be a hex literal the rasteriser will accept and never
    // markup a frames string smuggled in.
    const marks = buildSprayOverlayMarks({
      holds: [wallHolds[0]],
      frames: 'p501r99',
      canonicalToPhoto: identityMatrix,
      photoToPlaced: 1,
    });
    const svg = buildSprayOverlaySvg({ width: 900, height: 1200, marks });
    expect(svg).not.toContain('<script');
    expect(svg).toMatch(/stroke="#[0-9a-fA-F]{3,6}"/);
  });
});
