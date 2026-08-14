// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { UserBoard } from '@boardsesh/shared-schema';

const mocks = vi.hoisted(() => ({
  useBoardsBySerialNumbers: vi.fn(),
  lastSerials: [] as string[],
}));

vi.mock('../../graphql/hooks', () => ({
  useBoardsBySerialNumbers: (serialNumbers: string[]) => {
    mocks.lastSerials = serialNumbers;
    return mocks.useBoardsBySerialNumbers(serialNumbers);
  },
}));

import { useForeignSerialBoard } from '../use-foreign-serial-board';

function board(overrides: Partial<UserBoard>): UserBoard {
  return {
    uuid: 'b',
    boardType: 'kilter',
    layoutId: 1,
    sizeId: 2,
    setIds: '3,4',
    name: 'Their Wall',
    canEdit: false,
    ...overrides,
  } as unknown as UserBoard;
}

describe('useForeignSerialBoard', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.useBoardsBySerialNumbers.mockReset().mockReturnValue({ data: [] });
    mocks.lastSerials = [];
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not query for serials shorter than 3 characters', () => {
    renderHook(() => useForeignSerialBoard('AB'));
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(mocks.lastSerials).toEqual([]);
  });

  it('queries the trimmed serial after the debounce and returns the foreign board', () => {
    mocks.useBoardsBySerialNumbers.mockReturnValue({ data: [board({ uuid: 'theirs', name: 'Their Wall' })] });
    const { result, rerender } = renderHook(({ serial }) => useForeignSerialBoard(serial), {
      initialProps: { serial: '  ABC-123  ' },
    });
    // Before the debounce elapses, nothing is queried.
    expect(mocks.lastSerials).toEqual([]);
    act(() => {
      vi.advanceTimersByTime(400);
    });
    rerender({ serial: '  ABC-123  ' });
    expect(mocks.lastSerials).toEqual(['ABC-123']);
    expect(result.current?.uuid).toBe('theirs');
  });

  it('returns null when the only match is editable (the user owns it)', () => {
    mocks.useBoardsBySerialNumbers.mockReturnValue({ data: [board({ uuid: 'mine', canEdit: true })] });
    const { result } = renderHook(() => useForeignSerialBoard('ABC-123'));
    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(result.current).toBeNull();
  });

  it('excludes the board currently being edited', () => {
    mocks.useBoardsBySerialNumbers.mockReturnValue({ data: [board({ uuid: 'current' })] });
    const { result } = renderHook(() => useForeignSerialBoard('ABC-123', 'current'));
    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(result.current).toBeNull();
  });
});
