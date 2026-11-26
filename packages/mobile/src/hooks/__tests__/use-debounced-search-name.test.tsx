// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useDebouncedSearchName } from '../use-debounced-search-name';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('useDebouncedSearchName', () => {
  it('commits the last normalized text once and keeps commands stable', () => {
    const onCommit = vi.fn();
    const { result, rerender } = renderHook(() => useDebouncedSearchName({ scopeKey: 'board-a', name: '', onCommit }));
    const commands = result.current;
    act(() => result.current.schedule('first'));
    act(() => {
      vi.advanceTimersByTime(200);
    });
    act(() => result.current.schedule('  final  '));
    act(() => {
      vi.advanceTimersByTime(299);
    });
    expect(onCommit).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(onCommit).toHaveBeenCalledExactlyOnceWith('final');
    rerender();
    expect(result.current).toBe(commands);
  });

  it('flushes pending text synchronously and cancels the scheduled duplicate', () => {
    const onCommit = vi.fn();
    const { result } = renderHook(() => useDebouncedSearchName({ scopeKey: 'a', name: 'old', onCommit }));
    act(() => {
      result.current.schedule(' new ');
      expect(result.current.read()).toBe('new');
      expect(result.current.readCommitted()).toBe('old');
      expect(result.current.flush()).toBe('new');
      expect(result.current.readCommitted()).toBe('new');
      expect(result.current.flush()).toBe('new');
      vi.runAllTimers();
    });
    expect(onCommit).toHaveBeenCalledExactlyOnceWith('new');
  });

  it('replaces the committed snapshot synchronously without duplicating an external commit', () => {
    const onCommit = vi.fn();
    const { result, rerender } = renderHook(({ name }) => useDebouncedSearchName({ scopeKey: 'a', name, onCommit }), {
      initialProps: { name: 'old' },
    });
    act(() => {
      result.current.schedule('pending');
      result.current.replace('recent preset');
      expect(result.current.readCommitted()).toBe('recent preset');
      expect(result.current.read()).toBe('recent preset');
      expect(result.current.flush()).toBe('recent preset');
      vi.runAllTimers();
    });
    expect(onCommit).not.toHaveBeenCalled();
    rerender({ name: 'recent preset' });
    expect(result.current.readCommitted()).toBe('recent preset');
  });

  it('cancels on scope changes and unmount, and reads externally replaced names', () => {
    const onCommit = vi.fn();
    const { result, rerender, unmount } = renderHook(
      ({ scopeKey, name }) => useDebouncedSearchName({ scopeKey, name, onCommit }),
      { initialProps: { scopeKey: 'a', name: 'old' } },
    );
    act(() => result.current.schedule('stale'));
    rerender({ scopeKey: 'b', name: 'restored' });
    expect(result.current.read()).toBe('restored');
    act(() => {
      vi.runAllTimers();
    });
    expect(onCommit).not.toHaveBeenCalled();
    act(() => result.current.schedule('unmounted'));
    unmount();
    act(() => {
      vi.runAllTimers();
    });
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('clears immediately without allowing the pending name to return', () => {
    const onCommit = vi.fn();
    const { result } = renderHook(() => useDebouncedSearchName({ scopeKey: 'a', name: 'old', onCommit }));
    act(() => {
      result.current.schedule('pending');
      result.current.clear();
      vi.runAllTimers();
    });
    expect(onCommit).toHaveBeenCalledExactlyOnceWith('');
    expect(result.current.read()).toBe('');
  });

  it('lets callers choose immediate empty typing versus debounced empty typing', () => {
    const onCommit = vi.fn();
    const { result, rerender } = renderHook(
      ({ immediate }) =>
        useDebouncedSearchName({ scopeKey: 'a', name: 'old', onCommit, commitEmptyImmediately: immediate }),
      { initialProps: { immediate: false } },
    );
    act(() => result.current.schedule('  '));
    expect(onCommit).not.toHaveBeenCalled();
    act(() => result.current.cancel());
    rerender({ immediate: true });
    act(() => result.current.schedule('  '));
    expect(onCommit).toHaveBeenCalledExactlyOnceWith('');
  });
});
