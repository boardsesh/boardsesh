// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useFrozenSearchBasis } from '../use-frozen-search-basis';

type Basis = { sortBy: string; hideCompleted?: boolean };

/**
 * Issue #5402. The swipe track pages against the search the climber selected from,
 * and only the next selection may re-derive it. Each test below names one way the
 * list can move under a track that is already being walked.
 */
describe('useFrozenSearchBasis', () => {
  it('falls back to the live basis before anything is captured', () => {
    const { result } = renderHook(({ basis }) => useFrozenSearchBasis<Basis>(basis), {
      initialProps: { basis: { sortBy: 'ascents' } },
    });

    expect(result.current.read()).toEqual({ sortBy: 'ascents' });
  });

  it('keeps the captured basis when the live one changes underneath', () => {
    const { result, rerender } = renderHook(({ basis }) => useFrozenSearchBasis<Basis>(basis), {
      initialProps: { basis: { sortBy: 'ascents' } as Basis },
    });

    result.current.capture();
    // The climber changes a filter with the drawer still open.
    rerender({ basis: { sortBy: 'ascents', hideCompleted: true } });

    expect(result.current.read()).toEqual({ sortBy: 'ascents' });
  });

  it('re-derives only on the next selection', () => {
    const { result, rerender } = renderHook(({ basis }) => useFrozenSearchBasis<Basis>(basis), {
      initialProps: { basis: { sortBy: 'ascents' } as Basis },
    });

    result.current.capture();
    rerender({ basis: { sortBy: 'rating' } });
    expect(result.current.read()).toEqual({ sortBy: 'ascents' });

    // A second tap IS a selection, so the track may follow the new search.
    result.current.capture();
    expect(result.current.read()).toEqual({ sortBy: 'rating' });
  });

  it('captures the basis as of the render it is called in, not a frame behind', () => {
    const { result, rerender } = renderHook(({ basis }) => useFrozenSearchBasis<Basis>(basis), {
      initialProps: { basis: { sortBy: 'ascents' } as Basis },
    });

    // A selection landing in the same commit as a filter change must freeze the
    // list the climber actually tapped, which is the newly rendered one.
    rerender({ basis: { sortBy: 'rating' } });
    result.current.capture();

    expect(result.current.read()).toEqual({ sortBy: 'rating' });
  });

  it('a refetch that reorders the list does not move the track', () => {
    // A send bumps the climb's ascent count, the list refetches, and the sort is
    // `ascents desc` — so the live basis is equal by value but a fresh object.
    const { result, rerender } = renderHook(({ basis }) => useFrozenSearchBasis<Basis>(basis), {
      initialProps: { basis: { sortBy: 'ascents' } as Basis },
    });

    result.current.capture();
    const frozen = result.current.read();
    rerender({ basis: { sortBy: 'ascents' } });

    expect(result.current.read()).toBe(frozen);
  });

  it('keeps a stable identity so the page fetcher does not churn', () => {
    const { result, rerender } = renderHook(({ basis }) => useFrozenSearchBasis<Basis>(basis), {
      initialProps: { basis: { sortBy: 'ascents' } as Basis },
    });

    const first = result.current;
    rerender({ basis: { sortBy: 'rating' } });

    expect(result.current).toBe(first);
  });
});
