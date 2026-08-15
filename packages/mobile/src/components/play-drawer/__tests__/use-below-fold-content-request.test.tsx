// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useBelowFoldContentRequest } from '../use-below-fold-content-request';

describe('useBelowFoldContentRequest', () => {
  it('opens from native drag preloading', () => {
    const { result } = renderHook(() => useBelowFoldContentRequest());

    act(() => result.current.request());

    expect(result.current.requested).toBe(true);
  });

  it('opens from a positive browser scroll offset without a drag event', () => {
    const { result } = renderHook(() => useBelowFoldContentRequest());

    act(() => result.current.requestFromScrollOffset(1));

    expect(result.current.requested).toBe(true);
  });

  it('stays closed at or above the top edge', () => {
    const { result } = renderHook(() => useBelowFoldContentRequest());

    act(() => {
      result.current.requestFromScrollOffset(0);
      result.current.requestFromScrollOffset(-12);
    });

    expect(result.current.requested).toBe(false);
  });
});
