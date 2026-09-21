// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useBrushSession } from '../use-brush-session';
import { pointInRing } from '@boardsesh/board-art-geometry/ring';

const HOLD = { id: 42, cx: 100, cy: 100, r: 28 };
const OUTLINE = [80, 80, 120, 80, 120, 120, 80, 120];
const STROKE = {
  placementId: HOLD.id,
  editKind: 'SILHOUETTE',
  hold: HOLD,
  baseOutlineBoardPx: OUTLINE,
  strokeBoardPx: [120, 100, 127, 100],
  brushRadiusBoardPx: 4,
  mode: 'add' as const,
};

describe('brush session undo', () => {
  it('reseeds the visible outline after undoing the first stroke', () => {
    const edited = renderHook(useBrushSession);
    const fresh = renderHook(useBrushSession);
    const beforeFirstStroke = edited.result.current.snapshot();
    expect(beforeFirstStroke).toBeNull();
    act(() => {
      expect(edited.result.current.applyStroke(STROKE).ok).toBe(true);
      edited.result.current.restore(beforeFirstStroke);
    });
    const nextStroke = { ...STROKE, strokeBoardPx: [100, 80, 100, 73] };
    expect(edited.result.current.applyStroke(nextStroke)).toEqual(fresh.result.current.applyStroke(nextStroke));
  });

  it('reseeds the restored outline after undoing a stroke that resized the bitmap', () => {
    const edited = renderHook(useBrushSession);
    const fresh = renderHook(useBrushSession);
    const first = edited.result.current.applyStroke(STROKE);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const beforeResize = edited.result.current.snapshot();
    expect(beforeResize).not.toBeNull();
    edited.result.current.applyStroke({
      ...STROKE,
      baseOutlineBoardPx: first.outlineBoardPx,
      strokeBoardPx: [120, 100, 180, 100],
    });
    expect(edited.result.current.snapshot()?.length).not.toBe(beforeResize?.length);
    edited.result.current.restore(beforeResize);
    const nextStroke = { ...STROKE, baseOutlineBoardPx: first.outlineBoardPx, strokeBoardPx: [100, 80, 100, 73] };
    expect(edited.result.current.applyStroke(nextStroke)).toEqual(fresh.result.current.applyStroke(nextStroke));
  });
});

it('does not resurrect a neck-trimmed lobe when the next stroke widens its former connection', () => {
  const edited = renderHook(useBrushSession);
  const lobedOutline = [
    80, 80, 120, 80, 120, 99.75, 130, 99.75, 130, 90, 150, 90, 150, 110, 130, 110, 130, 100.25, 120, 100.25, 120, 120,
    80, 120,
  ];
  expect(pointInRing(lobedOutline, 147, 100)).toBe(true);
  const first = edited.result.current.applyStroke({
    ...STROKE,
    baseOutlineBoardPx: lobedOutline,
    strokeBoardPx: [90, 80, 90, 76],
  });
  expect(first.ok).toBe(true);
  if (!first.ok) return;
  expect(pointInRing(first.outlineBoardPx, 147, 100)).toBe(false);
  const second = edited.result.current.applyStroke({
    ...STROKE,
    baseOutlineBoardPx: first.outlineBoardPx,
    strokeBoardPx: [118, 100, 136, 100],
  });
  expect(second.ok).toBe(true);
  if (!second.ok) return;
  expect(pointInRing(second.outlineBoardPx, 134, 100)).toBe(true);
  expect(pointInRing(second.outlineBoardPx, 147, 100)).toBe(false);
});
