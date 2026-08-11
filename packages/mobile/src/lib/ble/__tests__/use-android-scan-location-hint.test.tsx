// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

const platform = vi.hoisted(() => ({ OS: 'android' as string, apiLevel: 34 }));
const appState = vi.hoisted(() => ({ handlers: [] as Array<(state: string) => void> }));
vi.mock('react-native', () => ({
  get Platform() {
    return { OS: platform.OS };
  },
  AppState: {
    addEventListener: (_event: string, handler: (state: string) => void) => {
      appState.handlers.push(handler);
      return {
        remove: () => {
          appState.handlers = appState.handlers.filter((registered) => registered !== handler);
        },
      };
    },
  },
}));

const permissions = vi.hoisted(() => ({
  androidApiLevel: vi.fn(() => platform.apiLevel),
  getAndroidLocationPermissionState: vi.fn(async (): Promise<boolean | null> => false),
  requestAndroidScanLocationPermission: vi.fn(async () => true),
}));
vi.mock('../android-location-permission', () => permissions);

const services = vi.hoisted(() => ({
  getAndroidLocationServicesState: vi.fn(async (): Promise<boolean | null> => false),
  promptEnableAndroidLocationServices: vi.fn(async () => true),
}));
vi.mock('../android-location-services', () => services);

import { useAndroidScanLocationHint } from '../use-android-scan-location-hint';

function fireAppStateActive() {
  appState.handlers.forEach((handler) => handler('active'));
}

describe('useAndroidScanLocationHint', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    appState.handlers = [];
    platform.OS = 'android';
    platform.apiLevel = 34;
    permissions.androidApiLevel.mockImplementation(() => platform.apiLevel);
    permissions.getAndroidLocationPermissionState.mockResolvedValue(false);
    permissions.requestAndroidScanLocationPermission.mockResolvedValue(true);
    services.getAndroidLocationServicesState.mockResolvedValue(false);
    services.promptEnableAndroidLocationServices.mockResolvedValue(true);
  });

  it('offers the grant once an empty scan meets a location denial', async () => {
    const { result } = renderHook(() => useAndroidScanLocationHint(true));

    await waitFor(() => {
      expect(result.current.shouldOfferLocationGrant).toBe(true);
    });

    // API 34 is on the permission-only branch — the services toggle is
    // irrelevant there and must never be read.
    expect(services.getAndroidLocationServicesState).not.toHaveBeenCalled();
    expect(result.current.shouldOfferLocationServicesEnable).toBe(false);
  });

  it('stays quiet while the scan is still running or found boards', async () => {
    const { result } = renderHook(() => useAndroidScanLocationHint(false));

    // No permission read at all — this hook must not fire a PermissionsAndroid
    // call on every scan tick.
    expect(permissions.getAndroidLocationPermissionState).not.toHaveBeenCalled();
    expect(result.current.shouldOfferLocationGrant).toBe(false);
  });

  it('stays quiet when location is already granted — the empty list is real', async () => {
    permissions.getAndroidLocationPermissionState.mockResolvedValue(true);
    const { result } = renderHook(() => useAndroidScanLocationHint(true));

    await waitFor(() => {
      expect(permissions.getAndroidLocationPermissionState).toHaveBeenCalled();
    });
    expect(result.current.shouldOfferLocationGrant).toBe(false);
  });

  it('never reads the permission below Android 12', async () => {
    platform.apiLevel = 30;
    const { result } = renderHook(() => useAndroidScanLocationHint(true));

    expect(permissions.getAndroidLocationPermissionState).not.toHaveBeenCalled();
    expect(result.current.shouldOfferLocationGrant).toBe(false);
  });

  it('never reads the permission on iOS', async () => {
    platform.OS = 'ios';
    const { result } = renderHook(() => useAndroidScanLocationHint(true));

    expect(permissions.getAndroidLocationPermissionState).not.toHaveBeenCalled();
    expect(result.current.shouldOfferLocationGrant).toBe(false);
  });

  it('swaps to the granted state after a successful request', async () => {
    const { result } = renderHook(() => useAndroidScanLocationHint(true));
    await waitFor(() => {
      expect(result.current.shouldOfferLocationGrant).toBe(true);
    });

    await act(async () => {
      await result.current.requestLocationPermission();
    });

    expect(permissions.requestAndroidScanLocationPermission).toHaveBeenCalledOnce();
    expect(result.current.wasGranted).toBe(true);
    expect(result.current.shouldOfferLocationGrant).toBe(false);
  });

  it('keeps offering the grant after a denial', async () => {
    permissions.requestAndroidScanLocationPermission.mockResolvedValue(false);
    const { result } = renderHook(() => useAndroidScanLocationHint(true));
    await waitFor(() => {
      expect(result.current.shouldOfferLocationGrant).toBe(true);
    });

    await act(async () => {
      await result.current.requestLocationPermission();
    });

    expect(result.current.wasGranted).toBe(false);
    expect(result.current.shouldOfferLocationGrant).toBe(true);
  });

  it('drops a late permission read that resolves after the empty state closed', async () => {
    let resolveCheck: ((granted: boolean) => void) | undefined;
    permissions.getAndroidLocationPermissionState.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          resolveCheck = resolve;
        }),
    );

    const { result, rerender } = renderHook(({ active }) => useAndroidScanLocationHint(active), {
      initialProps: { active: true },
    });
    rerender({ active: false });

    await act(async () => {
      resolveCheck?.(false);
    });

    // A stale "location is denied" answer must not light the hint back up on a
    // picker that has since found boards or closed.
    expect(result.current.shouldOfferLocationGrant).toBe(false);
  });

  it('drops a late permission read that resolves after the user granted', async () => {
    // The system prompt is the newer, more authoritative answer. A `check` that
    // started before it and lands after must not put the grant button straight
    // back in front of someone who just accepted.
    let resolveCheck: ((granted: boolean) => void) | undefined;
    permissions.getAndroidLocationPermissionState.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          resolveCheck = resolve;
        }),
    );

    const { result } = renderHook(() => useAndroidScanLocationHint(true));

    await act(async () => {
      await result.current.requestLocationPermission();
    });
    expect(result.current.wasGranted).toBe(true);

    await act(async () => {
      resolveCheck?.(false);
    });

    expect(result.current.shouldOfferLocationGrant).toBe(false);
    expect(result.current.wasGranted).toBe(true);
  });
});

describe('useAndroidScanLocationHint — services toggle (API 23-30)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    appState.handlers = [];
    platform.OS = 'android';
    platform.apiLevel = 30;
    permissions.androidApiLevel.mockImplementation(() => platform.apiLevel);
    permissions.getAndroidLocationPermissionState.mockResolvedValue(false);
    permissions.requestAndroidScanLocationPermission.mockResolvedValue(true);
    services.getAndroidLocationServicesState.mockResolvedValue(false);
    services.promptEnableAndroidLocationServices.mockResolvedValue(true);
  });

  it('offers the services enable prompt on Android 11 with Location off', async () => {
    const { result } = renderHook(() => useAndroidScanLocationHint(true));

    await waitFor(() => {
      expect(result.current.shouldOfferLocationServicesEnable).toBe(true);
    });

    // The API<31 range never touches the permission — a granted permission is
    // assumed (denial already routed elsewhere before scanning began).
    expect(permissions.getAndroidLocationPermissionState).not.toHaveBeenCalled();
  });

  it('stays quiet when Location services are already on', async () => {
    services.getAndroidLocationServicesState.mockResolvedValue(true);
    const { result } = renderHook(() => useAndroidScanLocationHint(true));

    await waitFor(() => {
      expect(services.getAndroidLocationServicesState).toHaveBeenCalled();
    });
    expect(result.current.shouldOfferLocationServicesEnable).toBe(false);
  });

  it('stays quiet when the services state is unknown — never asserts a wrong hint', async () => {
    services.getAndroidLocationServicesState.mockResolvedValue(null);
    const { result } = renderHook(() => useAndroidScanLocationHint(true));

    await waitFor(() => {
      expect(services.getAndroidLocationServicesState).toHaveBeenCalled();
    });
    expect(result.current.shouldOfferLocationServicesEnable).toBe(false);
  });

  it('reads nothing at all while inactive', () => {
    const { result } = renderHook(() => useAndroidScanLocationHint(false));

    expect(services.getAndroidLocationServicesState).not.toHaveBeenCalled();
    expect(permissions.getAndroidLocationPermissionState).not.toHaveBeenCalled();
    expect(result.current.shouldOfferLocationServicesEnable).toBe(false);
  });

  it('swaps to the enabled state after a successful prompt', async () => {
    const { result } = renderHook(() => useAndroidScanLocationHint(true));
    await waitFor(() => {
      expect(result.current.shouldOfferLocationServicesEnable).toBe(true);
    });

    await act(async () => {
      await result.current.promptEnableLocationServices();
    });

    expect(services.promptEnableAndroidLocationServices).toHaveBeenCalledOnce();
    expect(result.current.servicesWereEnabled).toBe(true);
    expect(result.current.shouldOfferLocationServicesEnable).toBe(false);
  });

  it('keeps offering the prompt when it resolves false (settings-intent fallback)', async () => {
    services.promptEnableAndroidLocationServices.mockResolvedValue(false);
    const { result } = renderHook(() => useAndroidScanLocationHint(true));
    await waitFor(() => {
      expect(result.current.shouldOfferLocationServicesEnable).toBe(true);
    });

    await act(async () => {
      await result.current.promptEnableLocationServices();
    });

    expect(result.current.servicesWereEnabled).toBe(false);
    expect(result.current.shouldOfferLocationServicesEnable).toBe(true);
  });

  it('drops a late services read that resolves after the empty state closed', async () => {
    let resolveCheck: ((enabled: boolean | null) => void) | undefined;
    services.getAndroidLocationServicesState.mockImplementation(
      () =>
        new Promise<boolean | null>((resolve) => {
          resolveCheck = resolve;
        }),
    );

    const { result, rerender } = renderHook(({ active }) => useAndroidScanLocationHint(active), {
      initialProps: { active: true },
    });
    rerender({ active: false });

    await act(async () => {
      resolveCheck?.(false);
    });

    expect(result.current.shouldOfferLocationServicesEnable).toBe(false);
  });

  it('re-reads the services state when the app returns to the foreground', async () => {
    // The settings-intent fallback hands the user off to system settings —
    // there's no in-app callback, so a foreground transition is the only signal
    // that they might be back with the toggle flipped.
    const { result } = renderHook(() => useAndroidScanLocationHint(true));
    await waitFor(() => {
      expect(result.current.shouldOfferLocationServicesEnable).toBe(true);
    });

    services.getAndroidLocationServicesState.mockResolvedValue(true);
    await act(async () => {
      fireAppStateActive();
    });

    await waitFor(() => {
      expect(result.current.shouldOfferLocationServicesEnable).toBe(false);
    });
    expect(services.getAndroidLocationServicesState).toHaveBeenCalledTimes(2);
  });

  it('does not subscribe to AppState while inactive', () => {
    renderHook(() => useAndroidScanLocationHint(false));
    expect(appState.handlers).toHaveLength(0);
  });
});
