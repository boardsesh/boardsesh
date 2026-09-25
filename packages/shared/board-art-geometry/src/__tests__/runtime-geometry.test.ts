import { describe, it, expect, afterEach } from 'vitest';
import type { BoardArtGeometry } from '../types';
import {
  boardArtGeometryPending,
  clearBoardArtGeometryCache,
  getRuntimeGeometry,
  loadBoardArtGeometry,
  prefetchBoardArtGeometry,
  registerRuntimeGeometry,
  unregisterRuntimeGeometry,
} from '../loader';

const WALL_KEY = 'spray/4200-4200';

function geometryWith(outlines: Record<number, number[]>): BoardArtGeometry {
  return { outlines, silhouetteLightness: {}, ledBright: {} };
}

afterEach(() => {
  clearBoardArtGeometryCache();
});

describe('runtime geometry', () => {
  it('answers a key the shards have never heard of', () => {
    const query = { boardName: 'spray' as const, layoutId: 4200, sizeId: 4200 };
    expect(loadBoardArtGeometry(query)).toBeNull();

    registerRuntimeGeometry(WALL_KEY, geometryWith({ 7: [1, 0, 0, 1, -1, 0] }));

    expect(loadBoardArtGeometry(query)?.outlines[7]).toEqual([1, 0, 0, 1, -1, 0]);
  });

  it('survives the `null` the first miss memoised', () => {
    const query = { boardName: 'spray' as const, layoutId: 4200, sizeId: 4200 };
    // The miss above is cached as "absent from the catalogue, and that answer
    // never changes" — which is true of a shard and false of a wall. If the
    // runtime map were consulted after the shard cache, a surface that asked
    // before the query landed would get rings for the rest of the session.
    expect(loadBoardArtGeometry(query)).toBeNull();
    registerRuntimeGeometry(WALL_KEY, geometryWith({ 7: [1, 0, 0, 1, -1, 0] }));
    expect(loadBoardArtGeometry(query)).not.toBeNull();
  });

  it('replaces rather than merges, so a reset drops the holds that came off', () => {
    registerRuntimeGeometry(WALL_KEY, geometryWith({ 7: [1, 0, 0, 1, -1, 0], 8: [2, 0, 0, 2, -2, 0] }));
    registerRuntimeGeometry(WALL_KEY, geometryWith({ 9: [1, 1, -1, 1, -1, -1] }));

    const geometry = loadBoardArtGeometry({ boardName: 'spray', layoutId: 4200, sizeId: 4200 });
    expect(Object.keys(geometry?.outlines ?? {})).toEqual(['9']);
  });

  it('falls back to the catalogue once withdrawn', () => {
    registerRuntimeGeometry(WALL_KEY, geometryWith({ 7: [1, 0, 0, 1, -1, 0] }));
    expect(getRuntimeGeometry(WALL_KEY)).not.toBeNull();

    unregisterRuntimeGeometry(WALL_KEY);

    expect(getRuntimeGeometry(WALL_KEY)).toBeNull();
    expect(loadBoardArtGeometry({ boardName: 'spray', layoutId: 4200, sizeId: 4200 })).toBeNull();
  });

  it('never reports a registered key as still downloading', () => {
    registerRuntimeGeometry(WALL_KEY, geometryWith({}));
    expect(boardArtGeometryPending({ boardName: 'spray', layoutId: 4200, sizeId: 4200 })).toBe(false);
  });

  it('resolves the prefetch straight off the registration', async () => {
    registerRuntimeGeometry(WALL_KEY, geometryWith({ 7: [1, 0, 0, 1, -1, 0] }));
    await expect(prefetchBoardArtGeometry({ boardName: 'spray', layoutId: 4200, sizeId: 4200 })).resolves.toEqual(
      geometryWith({ 7: [1, 0, 0, 1, -1, 0] }),
    );
  });

  it('leaves a shipped catalogue shard alone', () => {
    // Kilter 1-28 is in the generated tables. Registering a WALL key must not be
    // able to reach it, and the catalogue answer must not change.
    const kilter = { boardName: 'kilter' as const, layoutId: 1, sizeId: 28 };
    const before = loadBoardArtGeometry(kilter);
    registerRuntimeGeometry(WALL_KEY, geometryWith({ 1: [1, 0, 0, 1, -1, 0] }));
    expect(loadBoardArtGeometry(kilter)).toBe(before);
  });
});
