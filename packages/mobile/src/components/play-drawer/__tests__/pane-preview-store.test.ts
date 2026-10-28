// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { reportPanePreview, usePanePlayerShowsPreview } from '../pane-preview-store';
import { resolvePlayerAngle } from '../player-angle';

describe('pane preview store', () => {
  it('says a pane shows a preview until that pane withdraws it', () => {
    const { result } = renderHook(() => usePanePlayerShowsPreview());
    const pane = Symbol('pane');
    expect(result.current).toBe(false);
    act(() => reportPanePreview(pane, true));
    expect(result.current).toBe(true);
    act(() => reportPanePreview(pane, false));
    expect(result.current).toBe(false);
  });

  it("never lets one pane clear another's preview", () => {
    const { result } = renderHook(() => usePanePlayerShowsPreview());
    const leaving = Symbol('leaving');
    const staying = Symbol('staying');
    act(() => {
      reportPanePreview(leaving, true);
      reportPanePreview(staying, true);
    });
    act(() => reportPanePreview(leaving, false));
    expect(result.current).toBe(true);
    act(() => reportPanePreview(staying, false));
    expect(result.current).toBe(false);
  });
});

describe('resolvePlayerAngle', () => {
  it('is the angle on a board that adjusts, and none on a fixed one or without an angle', () => {
    expect(resolvePlayerAngle({ isAngleAdjustable: true, angle: 40 })).toBe(40);
    expect(resolvePlayerAngle({ isAngleAdjustable: false, angle: 40 })).toBeNull();
    expect(resolvePlayerAngle({ isAngleAdjustable: true, angle: null })).toBeNull();
  });
});
