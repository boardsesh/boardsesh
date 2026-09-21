// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useBrushSession } from '../use-brush-session';

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
