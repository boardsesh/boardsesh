// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

const expoLocation = vi.hoisted(() => ({
  requestForegroundPermissionsAsync: vi.fn(),
  getCurrentPositionAsync: vi.fn(),
  Accuracy: { Balanced: 3 },
}));

vi.mock('expo-location', () => expoLocation);

import { useDeviceLocation } from '../use-device-location';

describe('useDeviceLocation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    expoLocation.requestForegroundPermissionsAsync.mockResolvedValue({ status: 'granted' });
    expoLocation.getCurrentPositionAsync.mockResolvedValue({ coords: { latitude: 1, longitude: 2 } });
  });

  it('resolves coords and status=granted when permission is granted', async () => {
    const { result } = renderHook(() => useDeviceLocation());
    expect(result.current.status).toBe('idle');

    await act(async () => {
      await result.current.request();
    });

    expect(result.current.status).toBe('granted');
    expect(result.current.coords).toEqual({ latitude: 1, longitude: 2 });
  });

  it('reports denied when permission is refused, without fetching position', async () => {
    expoLocation.requestForegroundPermissionsAsync.mockResolvedValue({ status: 'denied' });
    const { result } = renderHook(() => useDeviceLocation());

    await act(async () => {
      await result.current.request();
    });

    expect(result.current.status).toBe('denied');
    expect(result.current.coords).toBeNull();
    expect(expoLocation.getCurrentPositionAsync).not.toHaveBeenCalled();
  });

  it('does not re-call the native permission API after a denial (sticky)', async () => {
    expoLocation.requestForegroundPermissionsAsync.mockResolvedValue({ status: 'denied' });
    const { result } = renderHook(() => useDeviceLocation());

    await act(async () => {
      await result.current.request();
    });
    await act(async () => {
      await result.current.request();
    });

    expect(expoLocation.requestForegroundPermissionsAsync).toHaveBeenCalledTimes(1);
  });

  // The first-board picker offers Open Settings, so a climber can come back with
  // location allowed and tap "At a gym" again (#5654).
  it('asks again after a denial when the caller opts in', async () => {
    expoLocation.requestForegroundPermissionsAsync.mockResolvedValueOnce({ status: 'denied' });
    const { result } = renderHook(() => useDeviceLocation({ retryAfterDenial: true }));

    await act(async () => {
      await result.current.request();
    });
    expect(result.current.status).toBe('denied');

    await act(async () => {
      await result.current.request();
    });
    expect(expoLocation.requestForegroundPermissionsAsync).toHaveBeenCalledTimes(2);
    expect(result.current.status).toBe('granted');
  });

  it('reports unavailable when getting the position throws, and allows retry', async () => {
    expoLocation.getCurrentPositionAsync.mockRejectedValueOnce(new Error('gps error'));
    const { result } = renderHook(() => useDeviceLocation());

    await act(async () => {
      await result.current.request();
    });
    expect(result.current.status).toBe('unavailable');

    // unavailable is transient — a retry re-enters and can succeed.
    await act(async () => {
      await result.current.request();
    });
    expect(result.current.status).toBe('granted');
    expect(result.current.coords).toEqual({ latitude: 1, longitude: 2 });
  });

  // #5654: "Nothing within 20 km" and a tap on Find nearby. `request` is a
  // no-op once granted, so without a fresh fix the tap searched the same spot.
  describe('refresh', () => {
    async function granted() {
      const hook = renderHook(() => useDeviceLocation({ retryAfterDenial: true }));
      await act(async () => {
        await hook.result.current.request();
      });
      return hook;
    }

    it('takes a new fix and reports that the climber moved', async () => {
      const { result } = await granted();
      expoLocation.getCurrentPositionAsync.mockResolvedValueOnce({ coords: { latitude: 5, longitude: 6 } });

      let moved = false;
      await act(async () => {
        moved = await result.current.refresh();
      });

      expect(moved).toBe(true);
      expect(result.current.coords).toEqual({ latitude: 5, longitude: 6 });
      expect(result.current.status).toBe('granted');
      expect(expoLocation.requestForegroundPermissionsAsync).toHaveBeenCalledTimes(1);
    });

    it('keeps the same coordinates and says so when the climber has not moved', async () => {
      const { result } = await granted();
      const before = result.current.coords;

      let moved = true;
      await act(async () => {
        moved = await result.current.refresh();
      });

      expect(moved).toBe(false);
      expect(result.current.coords).toBe(before);
    });

    it('keeps the old fix when the new one fails', async () => {
      const { result } = await granted();
      expoLocation.getCurrentPositionAsync.mockRejectedValueOnce(new Error('gps error'));

      let moved = true;
      await act(async () => {
        moved = await result.current.refresh();
      });

      expect(moved).toBe(false);
      expect(result.current.status).toBe('granted');
      expect(result.current.coords).toEqual({ latitude: 1, longitude: 2 });
    });

    it('does nothing before location is granted', async () => {
      const { result } = renderHook(() => useDeviceLocation());

      let moved = true;
      await act(async () => {
        moved = await result.current.refresh();
      });

      expect(moved).toBe(false);
      expect(result.current.status).toBe('idle');
      expect(expoLocation.getCurrentPositionAsync).not.toHaveBeenCalled();
    });

    it('does nothing while the first request is still in flight', async () => {
      let resolvePermission: ((value: { status: string }) => void) | undefined;
      expoLocation.requestForegroundPermissionsAsync.mockReturnValue(
        new Promise((resolve) => {
          resolvePermission = resolve;
        }),
      );
      const { result } = renderHook(() => useDeviceLocation({ retryAfterDenial: true }));

      let first: Promise<void> = Promise.resolve();
      act(() => {
        first = result.current.request();
      });
      await waitFor(() => expect(result.current.status).toBe('loading'));

      let moved = true;
      await act(async () => {
        moved = await result.current.refresh();
      });
      expect(moved).toBe(false);
      expect(expoLocation.getCurrentPositionAsync).not.toHaveBeenCalled();

      await act(async () => {
        resolvePermission?.({ status: 'granted' });
        await first;
      });
      expect(result.current.status).toBe('granted');
      expect(expoLocation.getCurrentPositionAsync).toHaveBeenCalledTimes(1);
    });

    // A second tap on Find nearby while the first fix is still coming in.
    it('takes one fix for two taps in a row', async () => {
      const { result } = await granted();
      let resolvePosition: ((value: { coords: { latitude: number; longitude: number } }) => void) | undefined;
      expoLocation.getCurrentPositionAsync.mockReturnValueOnce(
        new Promise((resolve) => {
          resolvePosition = resolve;
        }),
      );

      let first: Promise<boolean> = Promise.resolve(false);
      act(() => {
        first = result.current.refresh();
      });
      await waitFor(() => expect(result.current.status).toBe('loading'));

      let secondMoved = true;
      await act(async () => {
        secondMoved = await result.current.refresh();
      });
      expect(secondMoved).toBe(false);

      let firstMoved = false;
      await act(async () => {
        resolvePosition?.({ coords: { latitude: 5, longitude: 6 } });
        firstMoved = await first;
      });
      expect(firstMoved).toBe(true);
      expect(result.current.status).toBe('granted');
      // One call for the grant, one for the first refresh; none for the second.
      expect(expoLocation.getCurrentPositionAsync).toHaveBeenCalledTimes(2);
    });
  });

  it('does not start a second request while one is in flight', async () => {
    let resolvePermission: ((value: { status: string }) => void) | undefined;
    expoLocation.requestForegroundPermissionsAsync.mockReturnValue(
      new Promise((resolve) => {
        resolvePermission = resolve;
      }),
    );
    const { result } = renderHook(() => useDeviceLocation());

    let first: Promise<void> = Promise.resolve();
    act(() => {
      first = result.current.request();
    });
    await waitFor(() => expect(result.current.status).toBe('loading'));

    // Second tap while loading is a no-op.
    await act(async () => {
      await result.current.request();
    });
    expect(expoLocation.requestForegroundPermissionsAsync).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolvePermission?.({ status: 'granted' });
      await first;
    });
    expect(result.current.status).toBe('granted');
  });
});
