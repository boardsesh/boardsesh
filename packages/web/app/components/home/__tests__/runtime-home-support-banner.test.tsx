import React from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vite-plus/test';
import { MarketingCapabilitiesContext } from '../../marketing/marketing-capabilities-context';
import RuntimeHomeSupportBanner from '../runtime-home-support-banner';

vi.mock('../home-support-banner', () => ({ default: () => <aside data-testid="monthly-ask" /> }));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-12-03T12:00:00Z'));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function ConfiguredBanner({ available }: { available: boolean }) {
  return (
    <MarketingCapabilitiesContext.Provider
      value={{ enableExpoAuthBridge: false, developerHref: '/docs', hasMonthlySupport: available }}
    >
      <RuntimeHomeSupportBanner />
    </MarketingCapabilitiesContext.Provider>
  );
}

it('waits for runtime monthly availability and removes the ask when configuration is disabled', async () => {
  const view = render(<ConfiguredBanner available={false} />);
  expect(screen.queryByTestId('monthly-ask')).toBeNull();
  view.rerender(<ConfiguredBanner available />);
  expect(await screen.findByTestId('monthly-ask')).toBeTruthy();
  view.rerender(<ConfiguredBanner available={false} />);
  expect(screen.queryByTestId('monthly-ask')).toBeNull();
});

it('keeps a cached homepage outside the UTC window free of the monthly ask', async () => {
  vi.setSystemTime(new Date('2026-12-08T00:00:00Z'));
  render(<ConfiguredBanner available />);
  await act(async () => {});
  expect(screen.queryByTestId('monthly-ask')).toBeNull();
});

it('loads the banner when a cached homepage returns on day one with the same runtime configuration', async () => {
  vi.setSystemTime(new Date('2026-11-30T23:59:00Z'));
  render(<ConfiguredBanner available />);
  expect(screen.queryByTestId('monthly-ask')).toBeNull();
  vi.setSystemTime(new Date('2026-12-01T00:00:00Z'));
  await act(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
  expect(await screen.findByTestId('monthly-ask')).toBeTruthy();
});
