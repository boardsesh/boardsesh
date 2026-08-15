import { describe, it, expect, vi } from 'vite-plus/test';
import { renderHook, act } from '@testing-library/react';
import { useHoldTypePicker } from '../use-hold-type-picker';
import type { LitUpHoldsMap } from '../../board-renderer/types';

const makeAnchor = () => document.createElement('div');

describe('useHoldTypePicker', () => {
  it('starts closed', () => {
    const setHoldState = vi.fn();
    const { result } = renderHook(() => useHoldTypePicker({ litUpHoldsMap: {}, setHoldState }));

    expect(result.current.anchorEl).toBeNull();
    expect(result.current.currentState).toBe('OFF');
  });

  it('handleHoldClick anchors the picker against the tapped element', () => {
    const setHoldState = vi.fn();
    const { result } = renderHook(() => useHoldTypePicker({ litUpHoldsMap: {}, setHoldState }));

    const anchor = makeAnchor();
    act(() => {
      result.current.handleHoldClick(42, anchor);
    });

    expect(result.current.anchorEl).toBe(anchor);
  });

  it('exposes the current state from litUpHoldsMap when a hold is tapped', () => {
    const setHoldState = vi.fn();
    const litUpHoldsMap: LitUpHoldsMap = {
      42: { state: 'FINISH', color: '#FF00FF', displayColor: '#FF00FF' },
    };

    const { result, rerender } = renderHook(
      ({ map }: { map: LitUpHoldsMap }) => useHoldTypePicker({ litUpHoldsMap: map, setHoldState }),
      { initialProps: { map: litUpHoldsMap } },
    );

    expect(result.current.currentState).toBe('OFF');

    act(() => {
      result.current.handleHoldClick(42, makeAnchor());
    });

    rerender({ map: litUpHoldsMap });
    expect(result.current.currentState).toBe('FINISH');
  });

  it('falls back to OFF when the tapped hold is not in the map', () => {
    const setHoldState = vi.fn();
    const { result } = renderHook(() => useHoldTypePicker({ litUpHoldsMap: {}, setHoldState }));

    act(() => {
      result.current.handleHoldClick(99, makeAnchor());
    });

    expect(result.current.currentState).toBe('OFF');
  });

  it('handleSelect calls setHoldState with the tapped hold id and clears the picker', () => {
    const setHoldState = vi.fn();
    const { result } = renderHook(() => useHoldTypePicker({ litUpHoldsMap: {}, setHoldState }));

    act(() => {
      result.current.handleHoldClick(7, makeAnchor());
    });
    act(() => {
      result.current.handleSelect('STARTING');
    });

    expect(setHoldState).toHaveBeenCalledWith(7, 'STARTING');
    expect(result.current.anchorEl).toBeNull();
  });

  it('handleSelect is a no-op when nothing is open', () => {
    const setHoldState = vi.fn();
    const { result } = renderHook(() => useHoldTypePicker({ litUpHoldsMap: {}, setHoldState }));

    act(() => {
      result.current.handleSelect('STARTING');
    });

    expect(setHoldState).not.toHaveBeenCalled();
  });

  it('handleClose clears the picker without calling setHoldState again', () => {
    const setHoldState = vi.fn();
    // Start with an existing hold so handleHoldClick does not auto-assign HAND
    const litUpHoldsMap: LitUpHoldsMap = {
      7: { state: 'HAND', color: '#00FFFF', displayColor: '#00FFFF' },
    };
    const { result } = renderHook(() => useHoldTypePicker({ litUpHoldsMap, setHoldState }));

    act(() => {
      result.current.handleHoldClick(7, makeAnchor());
    });
    act(() => {
      result.current.handleClose();
    });

    expect(result.current.anchorEl).toBeNull();
    expect(setHoldState).not.toHaveBeenCalled();
  });
});
