// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
const observations = vi.hoisted(() => ({
  visible: vi.fn(),
  invalidate: vi.fn(),
  focus: null as (() => (() => void) | undefined) | null,
}));
vi.mock('../memory-profile', () => ({
  MEMORY_PROFILING_ENABLED: true,
  memoryOwner: () => 'list-owner',
  memoryProfile: observations,
}));
vi.mock('expo-router', () => ({
  useFocusEffect: (callback: () => (() => void) | undefined) => {
    observations.focus = callback;
  },
}));
import { useMemoryListViewability } from '../use-memory-list-viewability';

describe('actual list viewport observations', () => {
  it('restores the unchanged viewport after blur/refocus and tracks recycled UUIDs', () => {
    const mounted = renderHook(() => useMemoryListViewability());
    act(() => {
      mounted.result.current?.({ viewableItems: [{ item: { uuid: 'old' }, isViewable: true }] });
    });
    let blur: (() => void) | undefined;
    act(() => {
      blur = observations.focus?.();
    });
    expect(observations.visible).toHaveBeenLastCalledWith('list-owner', 'list', ['old']);
    act(() => {
      blur?.();
    });
    expect(observations.visible).toHaveBeenLastCalledWith('list-owner', 'list', []);
    act(() => {
      observations.focus?.();
    });
    expect(observations.visible).toHaveBeenLastCalledWith('list-owner', 'list', ['old']);
    act(() => {
      mounted.result.current?.({
        viewableItems: [
          { item: { uuid: 'new' }, isViewable: true },
          { item: { uuid: 'prefetch' }, isViewable: false },
        ],
      });
    });
    expect(observations.visible).toHaveBeenLastCalledWith('list-owner', 'list', ['new']);
    mounted.unmount();
  });
  it('rejects oversized callback payloads without retaining them', () => {
    const mounted = renderHook(() => useMemoryListViewability());
    act(() => {
      observations.focus?.();
    });
    mounted.result.current?.({
      viewableItems: Array.from({ length: 101 }, (_, index) => ({ item: { uuid: String(index) }, isViewable: true })),
    });
    expect(observations.invalidate).toHaveBeenLastCalledWith('viewability-overflow');
    mounted.unmount();
  });
});
