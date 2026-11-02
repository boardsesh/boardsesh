// @vitest-environment jsdom
import { useState } from 'react';
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_CLIMB_FILTER_STATE, DEFAULT_CLIMB_BOARD_FILTER_STATE } from '@boardsesh/climb-filters';
import { useLiveClimbFilters, type ClimbFilterSelection } from '../use-live-climb-filters';

const initialSelection: ClimbFilterSelection = {
  filters: DEFAULT_CLIMB_FILTER_STATE,
  boardFilters: DEFAULT_CLIMB_BOARD_FILTER_STATE,
};
const nextSelection: ClimbFilterSelection = {
  filters: { ...DEFAULT_CLIMB_FILTER_STATE, minGrade: 15 },
  boardFilters: { onlyBenchmarks: true },
};

function renderFilters(scopeKey: string | null = 'kilter|8|25|26,27|35|true') {
  const onSelectionChange = vi.fn();
  const onDismiss = vi.fn();
  const rendered = renderHook(
    ({ scopeKey: currentScope, name }: { scopeKey: string | null; name: string }) => {
      const [selection, setSelection] = useState(initialSelection);
      const controls = useLiveClimbFilters({
        scopeKey: currentScope,
        selection,
        onSelectionChange: (filters, boardFilters) => {
          onSelectionChange(filters, boardFilters);
          setSelection({ filters, boardFilters });
        },
        onDismiss: (finalSelection) => onDismiss(finalSelection, name),
      });
      return { ...controls, committedSelection: selection };
    },
    { initialProps: { scopeKey, name: '' } },
  );
  return { ...rendered, onSelectionChange, onDismiss };
}

describe('live climb filter sessions', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('commits the whole selection immediately but coalesces queries for 250 ms', () => {
    const { result, onSelectionChange, onDismiss } = renderFilters();
    act(() => {
      result.current.openFilters();
    });
    act(() => result.current.onSelectionChange(nextSelection.filters, nextSelection.boardFilters));
    expect(result.current.showFilters).toBe(true);
    expect(result.current.committedSelection).toEqual(nextSelection);
    expect(onSelectionChange).toHaveBeenCalledExactlyOnceWith(nextSelection.filters, nextSelection.boardFilters);
    expect(result.current.querySelection).toEqual(initialSelection);
    expect(onDismiss).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(249);
    });
    expect(result.current.querySelection).toEqual(initialSelection);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current.querySelection).toEqual(nextSelection);
  });

  it('flushes a last selection and finalizes once when immediately swiped closed', () => {
    const { result, onDismiss } = renderFilters();
    act(() => {
      result.current.openFilters();
    });
    const close = result.current.closeFilters;
    act(() => {
      result.current.onSelectionChange(nextSelection.filters, nextSelection.boardFilters);
      close();
      close();
    });
    expect(result.current.showFilters).toBe(false);
    expect(result.current.querySelection).toEqual(nextSelection);
    expect(onDismiss).toHaveBeenCalledExactlyOnceWith(nextSelection, '');
    act(() => {
      vi.advanceTimersByTime(250);
    });
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('keeps the latest pair when close and reopen occur in one batch', () => {
    const { result } = renderFilters();
    act(() => {
      result.current.openFilters();
    });
    const oldClose = result.current.closeFilters;
    act(() => {
      result.current.onSelectionChange(nextSelection.filters, nextSelection.boardFilters);
      oldClose();
      result.current.openFilters();
    });
    expect(result.current.showFilters).toBe(true);
    expect(result.current.querySelection).toEqual(nextSelection);
    act(() => oldClose());
    expect(result.current.showFilters).toBe(true);
  });

  it('does not delay name updates again or restart the filter timer on a name-only render', () => {
    const { result, rerender, onDismiss } = renderFilters();
    act(() => {
      result.current.openFilters();
    });
    act(() => result.current.onSelectionChange(nextSelection.filters, nextSelection.boardFilters));
    act(() => {
      vi.advanceTimersByTime(200);
    });
    rerender({ scopeKey: 'kilter|8|25|26,27|35|true', name: 'crimp' });
    act(() => {
      vi.advanceTimersByTime(50);
    });
    expect(result.current.querySelection).toEqual(nextSelection);
    act(() => result.current.closeFilters());
    expect(onDismiss).toHaveBeenCalledExactlyOnceWith(nextSelection, 'crimp');
  });

  it('coalesces rapid edits into the final query pair without intermediate history', () => {
    const { result, onDismiss } = renderFilters();
    act(() => {
      result.current.openFilters();
    });
    act(() => result.current.onSelectionChange(nextSelection.filters, nextSelection.boardFilters));
    act(() => {
      vi.advanceTimersByTime(200);
    });
    const finalSelection = { ...nextSelection, filters: { ...nextSelection.filters, minGrade: 20 } };
    act(() => result.current.onSelectionChange(finalSelection.filters, finalSelection.boardFilters));
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(result.current.querySelection).toEqual(initialSelection);
    act(() => {
      vi.advanceTimersByTime(50);
    });
    expect(result.current.querySelection).toEqual(finalSelection);
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it.each(['kilter|8|25|26,27|40|true', 'tension|10|7|4|35|true', 'kilter|8|25|26,27|35|false'])(
    'rejects stale selection, name and close callbacks after scope changes to %s',
    (scopeKey) => {
      const { result, rerender, onSelectionChange, onDismiss } = renderFilters();
      act(() => {
        result.current.openFilters();
      });
      const oldControls = result.current;
      rerender({ scopeKey, name: '' });
      expect(result.current.showFilters).toBe(false);
      const nameChange = vi.fn();
      act(() => {
        oldControls.onSelectionChange(nextSelection.filters, nextSelection.boardFilters);
        oldControls.runWhileOpen(nameChange);
        oldControls.closeFilters();
        vi.advanceTimersByTime(250);
      });
      expect(onSelectionChange).not.toHaveBeenCalled();
      expect(nameChange).not.toHaveBeenCalled();
      expect(onDismiss).not.toHaveBeenCalled();
      expect(result.current.querySelection).toEqual(initialSelection);
    },
  );

  it('external hiding leaves live filters applied without finalizing a recent', () => {
    const { result, onDismiss } = renderFilters();
    act(() => {
      result.current.openFilters();
    });
    act(() => result.current.onSelectionChange(nextSelection.filters, nextSelection.boardFilters));
    act(() => result.current.hideFilters());
    expect(result.current.showFilters).toBe(false);
    expect(result.current.querySelection).toEqual(nextSelection);
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it('runs field actions only for the currently open filter session', () => {
    const { result } = renderFilters();
    const changeName = vi.fn();
    act(() => result.current.runWhileOpen(changeName));
    expect(changeName).not.toHaveBeenCalled();
    act(() => {
      result.current.openFilters();
    });
    act(() => result.current.runWhileOpen(changeName));
    expect(changeName).toHaveBeenCalledTimes(1);
  });

  it('ignores callbacks after unmounting and never opens without a board', () => {
    const { result, unmount, onDismiss } = renderFilters();
    act(() => {
      result.current.openFilters();
    });
    const oldClose = result.current.closeFilters;
    unmount();
    oldClose();
    expect(onDismiss).not.toHaveBeenCalled();
    const withoutBoard = renderFilters(null);
    act(() => {
      withoutBoard.result.current.openFilters();
    });
    expect(withoutBoard.result.current.showFilters).toBe(false);
  });

  // The Climbs list reports `Climb Filters Opened` only for a real opening.
  it('says whether a call opened the sheet', () => {
    const { result } = renderFilters();
    let opened: boolean | undefined;
    act(() => {
      opened = result.current.openFilters();
    });
    expect(opened).toBe(true);
    act(() => {
      opened = result.current.openFilters();
    });
    expect(opened).toBe(false);
    expect(renderFilters(null).result.current.openFilters()).toBe(false);
  });
});
