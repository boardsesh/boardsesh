// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

// donation-links.ts probes requireOptionalNativeModule('Storefront') at module
// scope, so each case reassigns the value the mock factory closes over and
// re-imports the module against it (same pattern as dev-launcher.test.ts).
type StorefrontMock = { getCountryCode(): Promise<string | null> } | null;

let storefrontMock: StorefrontMock = null;
const platformMock = { OS: 'ios' as string };
const flagsMock: Record<string, boolean | string | undefined> = {};

vi.mock('expo', () => ({
  requireOptionalNativeModule: () => storefrontMock,
}));
vi.mock('react-native', () => ({ Platform: platformMock }));
vi.mock('../../providers/feature-flags-provider', () => ({
  useFeatureFlag: (key: string) => flagsMock[key],
}));

async function loadDonationLinks() {
  vi.resetModules();
  return await import('../donation-links');
}

/** Render the hook and give the async storefront read a chance to land. */
async function renderAllowed(): Promise<boolean> {
  const { useDonationLinksAllowed } = await loadDonationLinks();
  const { result } = renderHook(() => useDonationLinksAllowed());
  // Nothing to wait for when the answer can only be false on the first frame and
  // stay false; waitFor settles immediately either way.
  await waitFor(() => expect(typeof result.current).toBe('boolean'));
  return result.current;
}

beforeEach(() => {
  storefrontMock = null;
  platformMock.OS = 'ios';
  for (const key of Object.keys(flagsMock)) delete flagsMock[key];
});

describe('useDonationLinksAllowed', () => {
  it('hides links on iOS while the flag is off, even in the US storefront', async () => {
    platformMock.OS = 'ios';
    storefrontMock = { getCountryCode: vi.fn().mockResolvedValue('USA') };

    expect(await renderAllowed()).toBe(false);
  });

  it('hides links on Android while the flag is off', async () => {
    platformMock.OS = 'android';

    expect(await renderAllowed()).toBe(false);
  });

  it('shows links on Android when the flag is on (PostHog carries the country targeting)', async () => {
    platformMock.OS = 'android';
    flagsMock['donation-links'] = true;

    expect(await renderAllowed()).toBe(true);
  });

  it('hides links on iOS when the storefront module is missing (every binary shipped today)', async () => {
    platformMock.OS = 'ios';
    flagsMock['donation-links'] = true;
    storefrontMock = null;

    expect(await renderAllowed()).toBe(false);
  });

  it('shows links on iOS once the storefront resolves to the US', async () => {
    platformMock.OS = 'ios';
    flagsMock['donation-links'] = true;
    storefrontMock = { getCountryCode: vi.fn().mockResolvedValue('USA') };

    const { useDonationLinksAllowed } = await loadDonationLinks();
    const { result } = renderHook(() => useDonationLinksAllowed());

    // Starts false — the native read has not landed on the first frame.
    expect(result.current).toBe(false);
    await waitFor(() => expect(result.current).toBe(true));
  });

  it('hides links on iOS in a non-US storefront', async () => {
    platformMock.OS = 'ios';
    flagsMock['donation-links'] = true;
    const getCountryCode = vi.fn().mockResolvedValue('AUS');
    storefrontMock = { getCountryCode };

    const { useDonationLinksAllowed } = await loadDonationLinks();
    const { result } = renderHook(() => useDonationLinksAllowed());
    await waitFor(() => expect(getCountryCode).toHaveBeenCalled());

    expect(result.current).toBe(false);
  });

  it('treats a rejected storefront read as unknown', async () => {
    platformMock.OS = 'ios';
    flagsMock['donation-links'] = true;
    storefrontMock = { getCountryCode: vi.fn().mockRejectedValue(new Error('StoreKit unavailable')) };

    expect(await renderAllowed()).toBe(false);
  });

  it('reads the storefront once across renders', async () => {
    platformMock.OS = 'ios';
    flagsMock['donation-links'] = true;
    const getCountryCode = vi.fn().mockResolvedValue('USA');
    storefrontMock = { getCountryCode };

    const { useDonationLinksAllowed } = await loadDonationLinks();
    const { result, rerender } = renderHook(() => useDonationLinksAllowed());
    await waitFor(() => expect(result.current).toBe(true));
    rerender();
    rerender();

    expect(getCountryCode).toHaveBeenCalledTimes(1);
  });

  it('does not flash back to the fallback when the screen is reopened', async () => {
    platformMock.OS = 'ios';
    flagsMock['donation-links'] = true;
    storefrontMock = { getCountryCode: vi.fn().mockResolvedValue('USA') };

    const { useDonationLinksAllowed } = await loadDonationLinks();
    const first = renderHook(() => useDonationLinksAllowed());
    await waitFor(() => expect(first.result.current).toBe(true));
    first.unmount();

    // Leaving and reopening Acknowledgements must not start on the fallback and
    // flip a frame later — the resolved storefront seeds the state directly.
    const second = renderHook(() => useDonationLinksAllowed());
    expect(second.result.current).toBe(true);
  });

  it('hides links on Expo web, where there is no storefront to read', async () => {
    platformMock.OS = 'web';
    flagsMock['donation-links'] = true;

    expect(await renderAllowed()).toBe(false);
  });

  it('points at the website, not a payment provider', async () => {
    const { SUPPORT_URL, SUPPORT_URL_DISPLAY } = await loadDonationLinks();

    expect(SUPPORT_URL).toBe('https://www.boardsesh.com/support');
    // The displayed form is the same address, bare enough to type off a screen.
    expect(SUPPORT_URL).toContain(SUPPORT_URL_DISPLAY.replace('boardsesh.com', 'www.boardsesh.com'));
  });
});
