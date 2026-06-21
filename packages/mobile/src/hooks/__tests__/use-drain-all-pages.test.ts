// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useDrainAllPages, type UseDrainAllPagesOptions } from '../use-drain-all-pages';

const baseProps = (overrides: Partial<UseDrainAllPagesOptions> = {}): UseDrainAllPagesOptions => ({
  hasMore: false,
  isLoading: false,
  isLoadingMore: false,
  loadMore: vi.fn(),
  ...overrides,
});

describe('useDrainAllPages', () => {
  it('fires loadMore on mount when a page is available and nothing is loading', () => {
    const loadMore = vi.fn();
    renderHook(() => useDrainAllPages(baseProps({ hasMore: true, loadMore })));
    expect(loadMore).toHaveBeenCalledTimes(1);
  });

  it('does not fire while the initial page is still loading', () => {
    const loadMore = vi.fn();
    renderHook(() => useDrainAllPages(baseProps({ hasMore: true, isLoading: true, loadMore })));
    expect(loadMore).not.toHaveBeenCalled();
  });

  it('does not fire while a subsequent page is in flight', () => {
    const loadMore = vi.fn();
    renderHook(() => useDrainAllPages(baseProps({ hasMore: true, isLoadingMore: true, loadMore })));
    expect(loadMore).not.toHaveBeenCalled();
  });

  it('does not fire once the list is exhausted', () => {
    const loadMore = vi.fn();
    renderHook(() => useDrainAllPages(baseProps({ hasMore: false, loadMore })));
    expect(loadMore).not.toHaveBeenCalled();
  });

  it('requests the next page after the previous one settles', () => {
    const loadMore = vi.fn();
    const { rerender } = renderHook((props: UseDrainAllPagesOptions) => useDrainAllPages(props), {
      initialProps: baseProps({ hasMore: true, isLoadingMore: true, loadMore }),
    });
    expect(loadMore).not.toHaveBeenCalled();

    // Page settled, more remain → drain fires for the next page.
    rerender(baseProps({ hasMore: true, isLoadingMore: false, loadMore }));
    expect(loadMore).toHaveBeenCalledTimes(1);
  });

  it('resumes draining after a reset re-arms hasMore (e.g. board switch)', () => {
    const loadMore = vi.fn();
    const { rerender } = renderHook((props: UseDrainAllPagesOptions) => useDrainAllPages(props), {
      initialProps: baseProps({ hasMore: false, loadMore }),
    });
    expect(loadMore).not.toHaveBeenCalled();

    // A board switch re-fetches page 0; once it lands hasMore is true again.
    rerender(baseProps({ hasMore: true, loadMore }));
    expect(loadMore).toHaveBeenCalledTimes(1);
  });
});
