import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { BOARD_RENDER_VERSION } from '@boardsesh/board-render/version';
import { loadBoardGeometry, resetBoardGeometryCache, type BoardGeometryQuery } from '../board-geometry-client';

vi.mock('@/app/components/board-renderer/util', () => ({
  getBoardGeometryEndpoint: () => '/api/internal/board-geometry',
}));

const kilterHomewall: BoardGeometryQuery = { boardName: 'kilter', layoutId: 8, sizeId: 25 };

const tracedArt = {
  outlines: { 100: [1, 0, 0, 1, -1, 0] },
  ledInner: { 100: [0.5, 0, 0, 0.5] },
  ledBright: { 100: [0.1, 0.2] },
  silhouetteLightness: { 100: 0.42 },
  wallLightness: { mean: 0.626, coverage: 1 },
};

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  resetBoardGeometryCache();
  fetchMock = vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve(tracedArt) }));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('loadBoardGeometry', () => {
  it('asks for one board config, stamped with the render version', async () => {
    await loadBoardGeometry(kilterHomewall);

    const [requested] = fetchMock.mock.calls[0] as [string];
    expect(requested).toContain('/api/internal/board-geometry?');
    expect(requested).toContain('board_name=kilter');
    expect(requested).toContain('layout_id=8');
    expect(requested).toContain('size_id=25');
    // The `v=` is what lets the response be cached immutably: without it a
    // re-traced board would keep serving last year's silhouettes.
    expect(requested).toContain(`v=${BOARD_RENDER_VERSION}`);
  });

  it('splits the traced art from the wall reading the veil is bucketed from', async () => {
    const geometry = await loadBoardGeometry(kilterHomewall);

    expect(geometry?.holdGeometry.outlines?.[100]).toEqual([1, 0, 0, 1, -1, 0]);
    expect(geometry?.holdGeometry.ledInner?.[100]).toEqual([0.5, 0, 0, 0.5]);
    expect(geometry?.holdGeometry.ledBright?.[100]).toEqual([0.1, 0.2]);
    expect(geometry?.holdGeometry.silhouetteLightness?.[100]).toBe(0.42);
    expect(geometry?.wallLightness).toEqual({ mean: 0.626, coverage: 1 });
  });

  it('fetches once however many cards ask at the same moment', async () => {
    // Fifty climb cards mount together on a list page. Memoising the promise —
    // not the result — is what makes that one request instead of fifty.
    const [first, second] = await Promise.all([loadBoardGeometry(kilterHomewall), loadBoardGeometry(kilterHomewall)]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(first).toBe(second);
    expect(await loadBoardGeometry(kilterHomewall)).toBe(first);
  });

  it('keeps one entry per board config', async () => {
    await loadBoardGeometry(kilterHomewall);
    await loadBoardGeometry({ ...kilterHomewall, sizeId: 26 });

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('resolves an empty-but-present result for a config the tracer skipped', async () => {
    // The backend answers `{}` with a 200 — "no silhouettes" is a normal answer,
    // and the renderer draws a ring at each placement radius instead. Note this
    // is NOT the null case: null is reserved for a fetch that failed, which is
    // what makes the retry in `loadBoardGeometry` distinguishable from a board
    // that simply has no traced art.
    fetchMock.mockResolvedValue({ ok: true, json: () => Promise.resolve({}) });

    const geometry = await loadBoardGeometry(kilterHomewall);
    expect(geometry).not.toBeNull();
    expect(geometry?.holdGeometry.outlines).toBeUndefined();
    expect(geometry?.wallLightness).toBeNull();
  });

  it('does not retry a board that legitimately has no traced art', async () => {
    // The flip side of the retry: an empty answer is a success, so it stays
    // memoised. Retrying it on every card would put one request per row on the
    // wire for a board that will never have silhouettes.
    fetchMock.mockResolvedValue({ ok: true, json: () => Promise.resolve({}) });

    await loadBoardGeometry(kilterHomewall);
    await loadBoardGeometry(kilterHomewall);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries after a failure instead of degrading for the rest of the session', async () => {
    // The regression this guards: memoising the null let one cold-backend moment
    // at page load cost every board on the page its silhouettes until reload.
    fetchMock.mockRejectedValueOnce(new Error('offline'));
    expect(await loadBoardGeometry(kilterHomewall)).toBeNull();

    fetchMock.mockResolvedValue({ ok: true, json: () => Promise.resolve(tracedArt) });
    expect((await loadBoardGeometry(kilterHomewall))?.holdGeometry.outlines?.[100]).toBeDefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('treats a non-2xx the same way, and retries it too', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 503, json: () => Promise.resolve({}) });
    expect(await loadBoardGeometry(kilterHomewall)).toBeNull();

    expect(await loadBoardGeometry(kilterHomewall)).not.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
