// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useGradeDisclosure } from '../use-grade-disclosure';

const layout = vi.hoisted(() => ({ isPad: false, widthClass: 'compact' }));
vi.mock('../use-device-layout', () => ({ useDeviceLayout: () => layout }));
beforeEach(() => {
  layout.isPad = false;
  layout.widthClass = 'compact';
});

describe('useGradeDisclosure', () => {
  it('delegates phone row persistence to the caller and dismisses only the popover', () => {
    const onRowShownChange = vi.fn();
    const beforeOpenPopover = vi.fn();
    const { result, rerender } = renderHook(
      ({ rowShown }) => useGradeDisclosure({ rowShown, onRowShownChange, beforeOpenPopover }),
      { initialProps: { rowShown: false } },
    );
    const open = result.current.open;
    act(() => result.current.open());
    expect(onRowShownChange).toHaveBeenLastCalledWith(true);
    rerender({ rowShown: true });
    expect(result.current.railOpen).toBe(true);
    expect(result.current.open).toBe(open);
    act(() => result.current.dismissPopover());
    expect(onRowShownChange).toHaveBeenCalledTimes(1);
    act(() => result.current.close());
    expect(onRowShownChange).toHaveBeenLastCalledWith(false);
    expect(beforeOpenPopover).not.toHaveBeenCalled();
  });

  it('keeps an iPad popover open through narrowing and never changes the stored row choice on close', () => {
    layout.isPad = true;
    layout.widthClass = 'regular';
    const onRowShownChange = vi.fn();
    const beforeOpenPopover = vi.fn();
    const { result, rerender } = renderHook(() =>
      useGradeDisclosure({ rowShown: true, onRowShownChange, beforeOpenPopover }),
    );
    act(() => result.current.open());
    expect(beforeOpenPopover).toHaveBeenCalledOnce();
    expect(result.current.popoverOpen).toBe(true);
    layout.widthClass = 'compact';
    rerender();
    expect(result.current.usesPopover).toBe(true);
    act(() => result.current.close());
    expect(result.current.popoverOpen).toBe(false);
    expect(result.current.usesPopover).toBe(false);
    expect(onRowShownChange).not.toHaveBeenCalled();
    expect(result.current.railOpen).toBe(true);
  });
});
