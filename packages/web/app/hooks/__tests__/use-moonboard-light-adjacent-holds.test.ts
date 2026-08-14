import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useMoonboardLightAdjacentHolds } from '../use-moonboard-light-adjacent-holds';

const mockGetMoonboardLightAdjacentHolds = vi.fn();
const mockSetMoonboardLightAdjacentHolds = vi.fn();

vi.mock('@/app/lib/user-preferences-db', () => ({
  getMoonboardLightAdjacentHolds: (...args: unknown[]) => mockGetMoonboardLightAdjacentHolds(...args),
  setMoonboardLightAdjacentHolds: (...args: unknown[]) => mockSetMoonboardLightAdjacentHolds(...args),
}));

describe('useMoonboardLightAdjacentHolds', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetMoonboardLightAdjacentHolds.mockResolvedValue(false);
    mockSetMoonboardLightAdjacentHolds.mockResolvedValue(undefined);
  });

  it('initially returns false before the read resolves', () => {
    mockGetMoonboardLightAdjacentHolds.mockReturnValue(new Promise(() => {}));

    const { result } = renderHook(() => useMoonboardLightAdjacentHolds());

    expect(result.current[0]).toBe(false);
  });

  it('reflects the persisted value once the read resolves', async () => {
    mockGetMoonboardLightAdjacentHolds.mockResolvedValue(true);

    const { result } = renderHook(() => useMoonboardLightAdjacentHolds());

    await waitFor(() => {
      expect(result.current[0]).toBe(true);
    });
  });

  it('updates state immediately and persists on toggle', async () => {
    mockGetMoonboardLightAdjacentHolds.mockResolvedValue(false);

    const { result } = renderHook(() => useMoonboardLightAdjacentHolds());

    await waitFor(() => {
      expect(result.current[0]).toBe(false);
    });

    act(() => {
      result.current[1](true);
    });

    // State flips synchronously, before the persisted write settles.
    expect(result.current[0]).toBe(true);
    expect(mockSetMoonboardLightAdjacentHolds).toHaveBeenCalledWith(true);
  });

  it('does not update state after unmount (cancelled guard)', async () => {
    mockGetMoonboardLightAdjacentHolds.mockResolvedValue(true);

    const { unmount } = renderHook(() => useMoonboardLightAdjacentHolds());
    unmount();

    // The read resolves after unmount; the cancelled guard should stop the
    // hook from calling setState on an unmounted component (no crash/warning).
    await Promise.resolve();
    await Promise.resolve();
  });
});
