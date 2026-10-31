// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import type { BoardPresenceClimb } from '@boardsesh/shared-schema';

vi.mock('@react-native-async-storage/async-storage', () => {
  let storage: Record<string, string> = {};
  return {
    default: {
      getItem: vi.fn(async (key: string) => storage[key] ?? null),
      setItem: vi.fn(async (key: string, value: string) => {
        storage[key] = value;
      }),
      __reset: () => {
        storage = {};
      },
      __setRaw: (key: string, value: string) => {
        storage[key] = value;
      },
    },
  };
});

import AsyncStorage from '@react-native-async-storage/async-storage';
import { resetWallStripDismissalForTests, useUndismissedWallClimb, wallLightingKey } from '../wall-strip-dismissal';

type MockAsyncStorage = { __reset: () => void; __setRaw: (key: string, value: string) => void };
const storage = AsyncStorage as unknown as MockAsyncStorage;

function lighting(overrides: Partial<BoardPresenceClimb> = {}): BoardPresenceClimb {
  return { climbUuid: 'climb-1', sentAt: '2026-10-28T18:00:00Z', seq: 1, ...overrides };
}

beforeEach(() => {
  storage.__reset();
  resetWallStripDismissalForTests();
});

describe('wall strip dismissal', () => {
  it('holds the strip back until the stored choice has loaded', async () => {
    const climb = lighting();
    const { result } = renderHook(() => useUndismissedWallClimb(climb));
    expect(result.current.wallClimb).toBeNull();
    await waitFor(() => expect(result.current.wallClimb).toBe(climb));
  });

  it('hides a closed lighting and remembers it', async () => {
    const climb = lighting();
    const { result } = renderHook(() => useUndismissedWallClimb(climb));
    await waitFor(() => expect(result.current.wallClimb).toBe(climb));
    act(() => result.current.dismiss());
    expect(result.current.wallClimb).toBeNull();
    await waitFor(() =>
      expect(AsyncStorage.setItem).toHaveBeenCalledWith(
        'wallStripDismissedLighting',
        JSON.stringify(wallLightingKey(climb)),
      ),
    );
  });

  it('keeps a lighting closed across launches', async () => {
    const climb = lighting();
    storage.__setRaw('wallStripDismissedLighting', JSON.stringify(wallLightingKey(climb)));
    const { result } = renderHook(() => useUndismissedWallClimb(climb));
    await act(async () => {});
    expect(result.current.wallClimb).toBeNull();
  });

  it('brings the strip back for a different climb or the same climb lit again', async () => {
    const { result, rerender } = renderHook(({ climb }) => useUndismissedWallClimb(climb), {
      initialProps: { climb: lighting() },
    });
    await waitFor(() => expect(result.current.wallClimb).not.toBeNull());
    act(() => result.current.dismiss());
    expect(result.current.wallClimb).toBeNull();

    const otherClimb = lighting({ climbUuid: 'climb-2', seq: 2 });
    rerender({ climb: otherClimb });
    expect(result.current.wallClimb).toBe(otherClimb);

    const relit = lighting({ sentAt: '2026-10-29T09:00:00Z', seq: 3 });
    rerender({ climb: relit });
    expect(result.current.wallClimb).toBe(relit);
  });

  it('returns null when the wall is dark', async () => {
    const { result } = renderHook(() => useUndismissedWallClimb(null));
    await act(async () => {});
    expect(result.current.wallClimb).toBeNull();
  });
});
