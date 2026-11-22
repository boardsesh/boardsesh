import { describe, expect, it } from 'vitest';
import type { SprayEditorHold } from '../spray-hold-editor-reducer';
import {
  buildSprayHoldViewportIndex,
  holdsInSprayViewport,
  type HoldViewportBounds,
} from '../spray-hold-viewport-index';

function hold(id: number, cx: number, cy: number, r = 10, outline: number[] | null = null): SprayEditorHold {
  return { id, cx, cy, r, outline, source: 'MANUAL', confidence: null, review: 'accepted', dirty: false };
}
const aroundOrigin = { minX: -5, minY: -5, maxX: 5, maxY: 5 };

describe('spray hold viewport index', () => {
  it('includes an outline whose centre and circle are outside the viewport', () => {
    const extended = hold(7, 20, 20, 10, [-3, -3, 1, -1, 1, 1, -1, 1]);
    const index = buildSprayHoldViewportIndex([extended], 1000, 1000);
    expect(holdsInSprayViewport(index, aroundOrigin)).toEqual([extended]);
  });

  it('uses exact bounding-box intersection rather than the whole candidate cell', () => {
    const visible = hold(1, 10, 10, 5);
    const nearby = hold(2, 20, 20, 2);
    const index = buildSprayHoldViewportIndex([nearby, visible], 3200, 3200);
    expect(holdsInSprayViewport(index, { minX: 4, minY: 4, maxX: 6, maxY: 6 })).toEqual([visible]);
  });

  it('includes circles touching a viewport edge and excludes a separated circle', () => {
    const touching = hold(2, 15, 0, 10);
    const separated = hold(3, 15.01, 0, 10);
    const index = buildSprayHoldViewportIndex([touching, separated], 1000, 1000);
    expect(holdsInSprayViewport(index, aroundOrigin)).toEqual([touching]);
  });

  it('deduplicates multi-cell holds and preserves negative-id order and object references', () => {
    const positive = hold(8, 50, 50, 30);
    const firstLocal = hold(-1, 50, 50, 30);
    const secondLocal = hold(-2, 50, 50, 30);
    const index = buildSprayHoldViewportIndex([positive, firstLocal, secondLocal], 320, 320);
    const result = holdsInSprayViewport(index, { minX: 0, minY: 0, maxX: 100, maxY: 100 });
    expect(result).toEqual([secondLocal, firstLocal, positive]);
    expect(result[0]).toBe(secondLocal);
    expect(result[1]).toBe(firstLocal);
    expect(result[2]).toBe(positive);
  });

  it('returns only the local hold from a sparse 1500-hold wall', () => {
    const wall = Array.from({ length: 1500 }, (_, position) =>
      hold(position + 1, 50 + (position % 50) * 100, 50 + Math.floor(position / 50) * 100, 5),
    );
    const index = buildSprayHoldViewportIndex(wall, 5000, 3000);
    const result = holdsInSprayViewport(index, { minX: 48, minY: 48, maxX: 52, maxY: 52 });
    expect(result).toEqual([wall[0]]);
    expect(result[0]).toBe(wall[0]);
  });

  it('rebuilds moved, resized and replaced geometry without reusing stale bounds', () => {
    const original = hold(1, 20, 20, 5);
    const firstIndex = buildSprayHoldViewportIndex([original], 1000, 1000);
    expect(holdsInSprayViewport(firstIndex, aroundOrigin)).toEqual([]);
    const moved = { ...original, cx: 0, cy: 0 };
    expect(holdsInSprayViewport(buildSprayHoldViewportIndex([moved], 1000, 1000), aroundOrigin)).toEqual([moved]);
    const resized = { ...original, r: 100 };
    expect(holdsInSprayViewport(buildSprayHoldViewportIndex([resized], 1000, 1000), aroundOrigin)).toEqual([resized]);
    const replaced = { ...original, outline: [-4, -4, 1, -1, 1, 1, -1, 1] };
    expect(holdsInSprayViewport(buildSprayHoldViewportIndex([replaced], 1000, 1000), aroundOrigin)).toEqual([replaced]);
    expect(holdsInSprayViewport(firstIndex, aroundOrigin)).toEqual([]);
  });

  it('keeps giant outlines in one oversized entry instead of exploding the grid', () => {
    const giant = hold(-1, 0, 0, 1e100, [-2, -2, 2, -2, 2, 2, -2, 2]);
    const index = buildSprayHoldViewportIndex([giant], 320, 320);
    expect(index.cells.size).toBe(0);
    expect(index.oversized).toHaveLength(1);
    expect(holdsInSprayViewport(index, aroundOrigin)).toEqual([giant]);
    expect(holdsInSprayViewport(index, { minX: -1e200, minY: -1e200, maxX: 1e200, maxY: 1e200 })).toEqual([giant]);
  });

  it('handles an enormous query over distant sparse cells without walking empty coordinates', () => {
    const distant = [hold(1, -1e10, 0), hold(2, 1e10, 0)];
    const index = buildSprayHoldViewportIndex(distant, 320, 320);
    expect(holdsInSprayViewport(index, { minX: -1e100, minY: -1e100, maxX: 1e100, maxY: 1e100 })).toEqual(distant);
  });

  it.each([
    [0, 100],
    [100, 0],
    [-1, 100],
    [NaN, 100],
    [100, Infinity],
    [Number.MIN_VALUE, Number.MIN_VALUE],
  ])('refuses invalid board dimensions %s × %s', (width, height) => {
    const index = buildSprayHoldViewportIndex([hold(1, 0, 0)], width, height);
    expect(holdsInSprayViewport(index, aroundOrigin)).toEqual([]);
  });

  it.each([
    { minX: NaN, minY: 0, maxX: 10, maxY: 10 },
    { minX: 0, minY: 0, maxX: Infinity, maxY: 10 },
    { minX: 10, minY: 0, maxX: 0, maxY: 10 },
    { minX: 0, minY: 10, maxX: 10, maxY: 0 },
  ] satisfies HoldViewportBounds[])('refuses invalid query bounds', (bounds) => {
    expect(holdsInSprayViewport(buildSprayHoldViewportIndex([hold(1, 0, 0)], 320, 320), bounds)).toEqual([]);
  });

  it('ignores invalid geometry without poisoning nearby valid holds', () => {
    const valid = hold(-1, 0, 0);
    const invalid = [
      hold(1, NaN, 0),
      hold(2, 0, Infinity),
      hold(3, 0, 0, 0),
      hold(4, 0, 0, Infinity),
      hold(5, 0, 0, 10, [0, 0, 1, NaN, 1, 1]),
      hold(6, 0, 0, 10, [0, 0, 1]),
      hold(7, Number.MAX_VALUE, 0, Number.MAX_VALUE),
    ];
    expect(holdsInSprayViewport(buildSprayHoldViewportIndex([...invalid, valid], 320, 320), aroundOrigin)).toEqual([
      valid,
    ]);
  });
});

describe('viewport index lifetime', () => {
  it('reuses built bins across magnifier unmount/remount for the same immutable wall', () => {
    const holds = [hold(1, 100, 100), hold(2, 200, 200)];
    const first = buildSprayHoldViewportIndex(holds, 1000, 1000);
    expect(buildSprayHoldViewportIndex(holds, 1000, 1000)).toBe(first);
    expect(buildSprayHoldViewportIndex([...holds], 1000, 1000)).not.toBe(first);
    expect(buildSprayHoldViewportIndex(holds, 2000, 1000)).not.toBe(first);
  });
});
