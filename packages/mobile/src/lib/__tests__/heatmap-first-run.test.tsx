// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

const store = vi.hoisted(() => ({ value: null as unknown, writes: [] as unknown[] }));
vi.mock('../preference-store', () => ({
  getPreference: async () => store.value,
  setPreference: async (_key: string, value: unknown) => {
    store.value = value;
    store.writes.push(value);
  },
}));

import { HEATMAP_CAPTION_VIEWS, useHeatmapFirstRunCaption } from '../heatmap-first-run';

beforeEach(() => {
  store.value = null;
  store.writes = [];
});

describe('useHeatmapFirstRunCaption', () => {
  it('shows on the first three switch-ons, counting one per switch-on, then never again', async () => {
    for (let view = 1; view <= HEATMAP_CAPTION_VIEWS; view++) {
      const { result, unmount } = renderHook(() => useHeatmapFirstRunCaption(true));
      await waitFor(() => expect(result.current).toBe(true));
      unmount();
    }
    expect(store.writes).toEqual([1, 2, 3]);

    const { result } = renderHook(() => useHeatmapFirstRunCaption(true));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(result.current).toBe(false);
    expect(store.writes).toEqual([1, 2, 3]);
  });

  it('does not count re-renders, only activations', async () => {
    const { result, rerender } = renderHook(({ active }) => useHeatmapFirstRunCaption(active), {
      initialProps: { active: true },
    });
    await waitFor(() => expect(result.current).toBe(true));
    rerender({ active: true });
    rerender({ active: true });
    expect(store.writes).toEqual([1]);
    rerender({ active: false });
    expect(result.current).toBe(false);
  });

  it('stays hidden while off', async () => {
    const { result } = renderHook(() => useHeatmapFirstRunCaption(false));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(result.current).toBe(false);
    expect(store.writes).toEqual([]);
  });
});
