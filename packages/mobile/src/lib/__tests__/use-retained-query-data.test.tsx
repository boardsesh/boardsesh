// @vitest-environment jsdom

import { cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { useRetainedQueryData } from '../use-retained-query-data';

type Result = { boards: string[]; totalCount: number };
type Query = { data: Result | undefined; isSuccess: boolean; isPlaceholderData: boolean; isError?: boolean };
const previous: Result = { boards: ['madrid-board'], totalCount: 1 };
const successful = (data: Result): Query => ({ data, isSuccess: true, isPlaceholderData: false });
const pending: Query = { data: undefined, isSuccess: false, isPlaceholderData: false };

afterEach(cleanup);

describe('useRetainedQueryData', () => {
  it('retains the last successful result while a new query is pending or fails', () => {
    const { result, rerender } = renderHook((query: Query) => useRetainedQueryData(query), {
      initialProps: successful(previous),
    });
    rerender(pending);
    expect(result.current).toBe(previous);
    rerender({ ...pending, isError: true });
    expect(result.current).toBe(previous);
  });

  it('does not save placeholder data as the successful fallback', () => {
    const placeholder: Result = { boards: ['placeholder-board'], totalCount: 1 };
    const { result, rerender } = renderHook((query: Query) => useRetainedQueryData(query), {
      initialProps: successful(previous),
    });
    rerender({ data: placeholder, isSuccess: true, isPlaceholderData: true });
    rerender(pending);
    expect(result.current).toBe(previous);
  });

  it('a successful empty response replaces earlier results', () => {
    const empty: Result = { boards: [], totalCount: 0 };
    const { result, rerender } = renderHook((query: Query) => useRetainedQueryData(query), {
      initialProps: successful(previous),
    });
    rerender(successful(empty));
    expect(result.current).toBe(empty);
    rerender(pending);
    expect(result.current).toBe(empty);
  });

  it('returns undefined before any successful response and after a placeholder disappears', () => {
    const { result, rerender } = renderHook((query: Query) => useRetainedQueryData(query), { initialProps: pending });
    expect(result.current).toBeUndefined();
    rerender({ data: previous, isSuccess: true, isPlaceholderData: true });
    rerender(pending);
    expect(result.current).toBeUndefined();
  });
});
