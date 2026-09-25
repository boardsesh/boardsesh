import { beforeEach, describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';

/**
 * The spray card runs its expensive half under the SHARED render cap
 * (`runOnRenderSemaphore`). Mocked here so a test can see that the guard was
 * entered at all, and can make it saturate without standing up 40 real
 * concurrent renders.
 */
const { renderGuard, FakeRenderQueueSaturatedError } = vi.hoisted(() => {
  class FakeRenderQueueSaturatedError extends Error {
    constructor() {
      super('Render queue is saturated');
      this.name = 'RenderQueueSaturatedError';
    }
  }
  return { renderGuard: { calls: 0, saturated: false }, FakeRenderQueueSaturatedError };
});

vi.mock('../services/board-render', () => ({
  RenderQueueSaturatedError: FakeRenderQueueSaturatedError,
  runOnRenderSemaphore: <T>(fn: () => Promise<T>): Promise<T> => {
    renderGuard.calls += 1;
    // Synchronous throw, exactly like the real one: the saturation check and
    // the enqueue must not be separated by an await.
    if (renderGuard.saturated) throw new FakeRenderQueueSaturatedError();
    return fn();
  },
}));

import {
  buildSprayOverlayMarks,
  buildSprayOverlaySvg,
  renderSprayOgCard,
  resetSprayOgCardCache,
  SprayPhotoUnavailableError,
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
  hiddenAt: null,
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
      // Public, published and promoted: every other gate would open. Hidden
      // means private for everybody but the owner, and a crawler is not the owner.
      name: 'a public wall an admin has hidden',
      overrides: { loadWall: vi.fn(async () => ({ ...publicWall, hiddenAt: new Date() })) },
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

  it('falls back to the decoded photo width when the version row has none', async () => {
    // A version written before `photo_width` existed. The scale then comes off
    // the decoded JPEG, so the mark has to land where the recorded width would
    // have put it — 900 px wide resized into 1200x630 places at 472 px, i.e.
    // photoToPlaced 0.525, and the p501 hold sits at canonical 200.
    const photo = await makePhotoJpeg();
    const withWidth = makeDeps({}, photo);
    const withoutWidth = makeDeps(
      { loadPublishedVersion: vi.fn(async () => ({ photoWidth: null, photoHeight: null, homography: null })) },
      photo,
    );

    const frames = uniqueFrames('p501r1');
    const recorded = await renderSprayOgCard({ layoutId: publicWall.layoutId, frames, format: 'jpeg' }, withWidth);
    const decoded = await renderSprayOgCard(
      { layoutId: publicWall.layoutId, frames: uniqueFrames('p501r1'), format: 'jpeg' },
      withoutWidth,
    );

    expect(recorded.kind).toBe('card');
    expect(decoded.kind).toBe('card');
    if (recorded.kind !== 'card' || decoded.kind !== 'card') return;
    // Same photograph either way, so the two cards have to be the same bytes.
    expect(decoded.buffer.equals(recorded.buffer)).toBe(true);
    // And the photo is decoded once per render, not twice.
    expect(withoutWidth.fetchPhotoBytes).toHaveBeenCalledTimes(1);
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

/**
 * Two review follow-ups on SW-16: the endpoint must not be a free DoS, and a
 * wall whose public object has gone missing must not 500 a link people posted.
 */
describe('renderSprayOgCard — backpressure and an unreadable photo', () => {
  beforeEach(() => {
    resetSprayOgCardCache();
    renderGuard.calls = 0;
    renderGuard.saturated = false;
  });

  it('runs the fetch-and-compose half under the shared render cap', async () => {
    const photo = await makePhotoJpeg();
    const result = await renderSprayOgCard(
      { layoutId: 90001, frames: uniqueFrames('p501r1'), format: 'jpeg' },
      makeDeps({}, photo),
    );

    expect(result.kind).toBe('card');
    expect(renderGuard.calls).toBe(1);
  });

  it('refuses a saturated queue before fetching a single photo byte', async () => {
    renderGuard.saturated = true;
    const fetchPhotoBytes = vi.fn(async () => Buffer.alloc(0));

    await expect(
      renderSprayOgCard(
        { layoutId: 90001, frames: uniqueFrames('p501r1'), format: 'jpeg' },
        makeDeps({ fetchPhotoBytes }),
      ),
    ).rejects.toThrow('Render queue is saturated');

    expect(fetchPhotoBytes).not.toHaveBeenCalled();
  });

  it('serves a cached card without entering the queue at all', async () => {
    const photo = await makePhotoJpeg();
    const frames = uniqueFrames('p501r1');
    const deps = makeDeps({}, photo);

    const first = await renderSprayOgCard({ layoutId: 90001, frames, format: 'jpeg' }, deps);
    expect(first.kind).toBe('card');
    expect(renderGuard.calls).toBe(1);

    // A hot card must never queue behind a cold render — that is the difference
    // between an unfurl storm being free and it being a render each.
    renderGuard.saturated = true;
    const second = await renderSprayOgCard({ layoutId: 90001, frames, format: 'jpeg' }, deps);
    expect(second.kind).toBe('card');
    expect(renderGuard.calls).toBe(1);
  });

  it.each([
    ['the bucket answers 404', new SprayPhotoUnavailableError('spray wall photo fetch failed with 404')],
    ['the read times out', new SprayPhotoUnavailableError('spray wall photo fetch did not complete')],
    ['the object is over the byte ceiling', new SprayPhotoUnavailableError('spray wall photo is 99999999 bytes')],
  ])('answers not-found, not 500, when %s', async (_label, thrown) => {
    const result = await renderSprayOgCard(
      { layoutId: 90001, frames: uniqueFrames('p501r1'), format: 'jpeg' },
      makeDeps({
        fetchPhotoBytes: vi.fn(async () => {
          throw thrown;
        }),
      }),
    );

    // The same `not-found` every visibility gate answers with, so a wall whose
    // photo vanished is still indistinguishable from one that never existed.
    expect(result.kind).toBe('not-found');
  });

  it('answers not-found when the bytes are not a decodable image', async () => {
    const result = await renderSprayOgCard(
      { layoutId: 90001, frames: uniqueFrames('p501r1'), format: 'jpeg' },
      makeDeps({ fetchPhotoBytes: vi.fn(async () => Buffer.from('this is not a jpeg')) }),
    );

    expect(result.kind).toBe('not-found');
  });

  it('still throws a genuine server fault rather than hiding it as not-found', async () => {
    const photo = await makePhotoJpeg();
    // A database error is NOT an unreadable photo, and swallowing it would turn
    // an outage into a wall of 404s on cards that should have rendered.
    await expect(
      renderSprayOgCard(
        { layoutId: 90001, frames: uniqueFrames('p501r1'), format: 'jpeg' },
        makeDeps(
          {
            loadAliveHolds: vi.fn(async () => {
              throw new Error('connection terminated unexpectedly');
            }),
          },
          photo,
        ),
      ),
    ).rejects.toThrow('connection terminated unexpectedly');
  });
});
