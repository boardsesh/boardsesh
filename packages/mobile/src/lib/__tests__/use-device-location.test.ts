// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

const expoLocation = vi.hoisted(() => ({
  getForegroundPermissionsAsync: vi.fn(),
  requestForegroundPermissionsAsync: vi.fn(),
  getCurrentPositionAsync: vi.fn(),
  Accuracy: { Balanced: 3 },
}));

vi.mock('expo-location', () => expoLocation);

const appState = vi.hoisted(() => ({
  listeners: new Set<(next: string) => void>(),
}));
vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  AppState: {
    addEventListener: (_type: string, listener: (next: string) => void) => {
      appState.listeners.add(listener);
      return { remove: () => appState.listeners.delete(listener) };
    },
  },
}));

import { locationPermissionFrom, useDeviceLocation, type LocationPermission } from '../use-device-location';

describe('locationPermissionFrom', () => {
  it.each([
    [{ status: 'granted', canAskAgain: true }, 'granted'],
    [{ status: 'undetermined', canAskAgain: true }, 'ask'],
    // Android after one refusal: the prompt can still ask.
    [{ status: 'denied', canAskAgain: true }, 'ask'],
    // iOS after a refusal, Android "Don't ask again": only Settings.
    [{ status: 'denied', canAskAgain: false }, 'blocked'],
  ])('%j → %s', (answer, permission) => {
    expect(locationPermissionFrom(answer)).toBe(permission);
  });

  // A browser never shows its prompt again after a refusal, whatever
  // expo-location's web answer says: Allow location would be a dead button.
  it.each([
    [{ status: 'denied', canAskAgain: true }, 'blocked'],
    [{ status: 'undetermined', canAskAgain: true }, 'ask'],
    [{ status: 'granted', canAskAgain: true }, 'granted'],
  ])('in a browser, %j → %s', (answer, permission) => {
    expect(locationPermissionFrom(answer, 'web')).toBe(permission);
  });
});

describe('useDeviceLocation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    expoLocation.getForegroundPermissionsAsync.mockResolvedValue({ status: 'granted' });
    expoLocation.requestForegroundPermissionsAsync.mockResolvedValue({ status: 'granted' });
    expoLocation.getCurrentPositionAsync.mockResolvedValue({ coords: { latitude: 1, longitude: 2 } });
  });

  // The board picker searches Near you on open, but only for a climber who
  // already said yes: the question itself waits for a tap.
  it.each([
    { permission: 'granted', status: 'granted', asked: true },
    { permission: 'undetermined', status: 'idle', asked: false },
    { permission: 'denied', status: 'idle', asked: false },
  ])('requestIfAllowed with $permission → $status', async ({ permission, status, asked }) => {
    expoLocation.getForegroundPermissionsAsync.mockResolvedValue({ status: permission });
    const { result } = renderHook(() => useDeviceLocation());

    await act(async () => {
      await result.current.requestIfAllowed();
    });

    expect(result.current.status).toBe(status);
    expect(expoLocation.requestForegroundPermissionsAsync).toHaveBeenCalledTimes(asked ? 1 : 0);
  });

  // The picker offers Allow location or Open Settings before anything is asked.
  it('reads the permission without asking', async () => {
    expoLocation.getForegroundPermissionsAsync.mockResolvedValue({ status: 'denied', canAskAgain: false });
    const { result } = renderHook(() => useDeviceLocation());
    expect(result.current.permission).toBe('unknown');

    await act(async () => {
      await result.current.requestIfAllowed();
    });

    expect(result.current.permission).toBe('blocked');
    expect(expoLocation.requestForegroundPermissionsAsync).not.toHaveBeenCalled();
  });

  // A screen waits on this, not on `permission`, which can stay unknown.
  it.each([
    ['answers', () => expoLocation.getForegroundPermissionsAsync.mockResolvedValue({ status: 'undetermined' }), 'ask'],
    ['throws', () => expoLocation.getForegroundPermissionsAsync.mockRejectedValue(new Error('no module')), 'unknown'],
  ])('marks the permission checked once the read %s, and resolves to it', async (_label, arrange, expected) => {
    arrange();
    const { result } = renderHook(() => useDeviceLocation());
    expect(result.current.permissionChecked).toBe(false);

    let resolved: string | undefined;
    await act(async () => {
      resolved = await result.current.requestIfAllowed();
    });

    expect(result.current.permissionChecked).toBe(true);
    expect(result.current.permission).toBe(expected);
    expect(resolved).toBe(expected);
  });

  it('resolves request to what the prompt left', async () => {
    expoLocation.requestForegroundPermissionsAsync.mockResolvedValue({ status: 'denied', canAskAgain: false });
    const { result } = renderHook(() => useDeviceLocation());

    let answer: string | undefined;
    await act(async () => {
      answer = await result.current.request();
    });
    expect(answer).toBe('blocked');
    expect(result.current.permissionChecked).toBe(true);

    // Sticky after a denial: a second call is a no-op that still says where it stands.
    await act(async () => {
      answer = await result.current.request();
    });
    expect(answer).toBe('blocked');
    expect(expoLocation.requestForegroundPermissionsAsync).toHaveBeenCalledOnce();
  });

  // The ask card reports the answer as the prompt closes, not seconds later
  // when the fix lands.
  it('hands the answer to onAnswer before the fix, and once', async () => {
    let landFix: ((position: { coords: { latitude: number; longitude: number } }) => void) | undefined;
    expoLocation.getCurrentPositionAsync.mockImplementation(
      () =>
        new Promise((resolve) => {
          landFix = resolve;
        }),
    );
    const onAnswer = vi.fn();
    const { result } = renderHook(() => useDeviceLocation());

    let done: Promise<LocationPermission> = Promise.resolve('unknown');
    act(() => {
      done = result.current.request({ onAnswer });
    });
    await waitFor(() => expect(onAnswer).toHaveBeenCalledExactlyOnceWith('granted'));
    expect(result.current.status).toBe('loading');

    await act(async () => {
      landFix?.({ coords: { latitude: 1, longitude: 2 } });
      await done;
    });
    expect(onAnswer).toHaveBeenCalledOnce();
    expect(result.current.status).toBe('granted');
  });

  it('answers at once with where it stands when the call is a no-op', async () => {
    const { result } = renderHook(() => useDeviceLocation());
    await act(async () => {
      await result.current.request();
    });
    const onAnswer = vi.fn();
    await act(async () => {
      await result.current.request({ onAnswer });
    });
    expect(onAnswer).toHaveBeenCalledExactlyOnceWith('granted');
  });

  it('takes the permission from the answer to the prompt', async () => {
    expoLocation.requestForegroundPermissionsAsync.mockResolvedValue({ status: 'denied', canAskAgain: false });
    const { result } = renderHook(() => useDeviceLocation({ retryAfterDenial: true }));

    await act(async () => {
      await result.current.request();
    });
    expect(result.current.permission).toBe('blocked');

    expoLocation.requestForegroundPermissionsAsync.mockResolvedValue({ status: 'granted' });
    await act(async () => {
      await result.current.request();
    });
    expect(result.current.permission).toBe('granted');
  });

  // Back from Settings with location turned on: the search starts by itself.
  it('reads again when the app comes back, when asked to', async () => {
    expoLocation.getForegroundPermissionsAsync.mockResolvedValue({ status: 'denied', canAskAgain: false });
    const { result, unmount } = renderHook(() => useDeviceLocation({ retryAfterDenial: true, rereadWhenActive: true }));
    await act(async () => {
      await result.current.requestIfAllowed();
    });
    expect(result.current.permission).toBe('blocked');

    expoLocation.getForegroundPermissionsAsync.mockResolvedValue({ status: 'granted' });
    await act(async () => {
      for (const listener of appState.listeners) listener('background');
    });
    expect(result.current.permission).toBe('blocked');
    await act(async () => {
      for (const listener of appState.listeners) listener('active');
    });
    await waitFor(() => expect(result.current.status).toBe('granted'));
    expect(result.current.permission).toBe('granted');

    unmount();
    expect(appState.listeners.size).toBe(0);
  });

  it('does not listen for the app coming back unless asked to', () => {
    renderHook(() => useDeviceLocation());
    expect(appState.listeners.size).toBe(0);
  });

  it('requestIfAllowed stays idle when the permission read throws', async () => {
    expoLocation.getForegroundPermissionsAsync.mockRejectedValue(new Error('no module'));
    const { result } = renderHook(() => useDeviceLocation());

    await act(async () => {
      await result.current.requestIfAllowed();
    });

    expect(result.current.status).toBe('idle');
    expect(expoLocation.requestForegroundPermissionsAsync).not.toHaveBeenCalled();
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

      let first: Promise<LocationPermission> = Promise.resolve('unknown');
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

    let first: Promise<LocationPermission> = Promise.resolve('unknown');
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
