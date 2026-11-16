// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The In range slot's nothing-heard state on Android, when the platform is
// plausibly withholding the scan's results: which fix it offers, and that a
// fix that worked starts a fresh scan.

const androidHint = vi.hoisted(() => ({
  shouldOfferLocationGrant: false,
  shouldOfferLocationServicesEnable: false,
  isRequesting: false,
  isPromptingServices: false,
  requestLocationPermission: vi.fn(async () => true),
  promptEnableLocationServices: vi.fn(async () => true),
  activeArgs: [] as boolean[],
}));
vi.mock('../../../lib/ble/use-android-scan-location-hint', () => ({
  useAndroidScanLocationHint: (active: boolean) => {
    androidHint.activeArgs.push(active);
    return { ...androidHint, wasGranted: false, servicesWereEnabled: false };
  },
}));

const { inRangeLocationHintKind, useInRangeLocationHint } = await import('../use-in-range-location-hint');

beforeEach(() => {
  androidHint.shouldOfferLocationGrant = false;
  androidHint.shouldOfferLocationServicesEnable = false;
  androidHint.requestLocationPermission.mockReset().mockResolvedValue(true);
  androidHint.promptEnableLocationServices.mockReset().mockResolvedValue(true);
  androidHint.activeArgs = [];
});

describe('inRangeLocationHintKind', () => {
  it.each([
    { grant: false, services: false, expected: null },
    { grant: true, services: false, expected: 'grant_location' },
    { grant: false, services: true, expected: 'enable_location_services' },
    { grant: true, services: true, expected: 'grant_location' },
  ])('grant $grant, services $services → $expected', ({ grant, services, expected }) => {
    expect(
      inRangeLocationHintKind({ shouldOfferLocationGrant: grant, shouldOfferLocationServicesEnable: services }),
    ).toBe(expected);
  });
});

describe('useInRangeLocationHint', () => {
  it('reads only while the nothing-heard state shows', () => {
    const rescan = vi.fn();
    const { rerender } = renderHook(({ active }) => useInRangeLocationHint(active, rescan), {
      initialProps: { active: false },
    });
    rerender({ active: true });
    expect(androidHint.activeArgs).toEqual([false, true]);
  });

  it('offers nothing when Android is not hiding anything', () => {
    const { result } = renderHook(() => useInRangeLocationHint(true, vi.fn()));
    expect(result.current).toBeNull();
  });

  it.each([
    { granted: true, rescans: 1 },
    { granted: false, rescans: 0 },
  ])('rescans after the location grant only when it was given ($granted)', async ({ granted, rescans }) => {
    androidHint.shouldOfferLocationGrant = true;
    androidHint.requestLocationPermission.mockResolvedValue(granted);
    const rescan = vi.fn();
    const { result } = renderHook(() => useInRangeLocationHint(true, rescan));
    expect(result.current?.kind).toBe('grant_location');

    await act(async () => {
      result.current?.onPress();
      await Promise.resolve();
    });
    expect(androidHint.requestLocationPermission).toHaveBeenCalledOnce();
    expect(rescan).toHaveBeenCalledTimes(rescans);
  });

  it.each([
    { enabled: true, rescans: 1 },
    { enabled: false, rescans: 0 },
  ])('rescans after Location is turned on only when it was ($enabled)', async ({ enabled, rescans }) => {
    androidHint.shouldOfferLocationServicesEnable = true;
    androidHint.promptEnableLocationServices.mockResolvedValue(enabled);
    const rescan = vi.fn();
    const { result } = renderHook(() => useInRangeLocationHint(true, rescan));
    expect(result.current?.kind).toBe('enable_location_services');

    await act(async () => {
      result.current?.onPress();
      await Promise.resolve();
    });
    expect(rescan).toHaveBeenCalledTimes(rescans);
  });
});
