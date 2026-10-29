// @vitest-environment jsdom

import React from 'react';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vite-plus/test';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { tFromCatalog } from '@/app/__test-helpers__/i18n-mock';

const preferences = vi.hoisted(() => ({
  getPreference: vi.fn(async (_key: string): Promise<boolean | null> => null),
  setPreference: vi.fn(async (_key: string, _value: boolean): Promise<void> => {}),
}));

vi.mock('@/app/lib/user-preferences-db', () => preferences);

vi.mock('react-i18next', () => ({
  useTranslation: (ns?: string) => ({
    t: (key: string, options?: Record<string, unknown>) => tFromCatalog(ns, key, options),
    i18n: { language: 'en-US' },
  }),
}));

vi.mock('@/app/components/i18n/locale-link', () => ({
  default: React.forwardRef<HTMLAnchorElement, { href: string; children?: React.ReactNode }>(
    ({ href, children, ...props }, ref) => (
      <a ref={ref} href={href} {...props}>
        {children}
      </a>
    ),
  ),
}));

const { default: HomeSupportBanner } = await import('../home-support-banner');

async function renderBanner() {
  const view = render(<HomeSupportBanner />);
  // Let the IndexedDB read settle.
  await act(async () => {});
  return view;
}

describe('HomeSupportBanner', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-12-10T09:00:00Z'));
    preferences.getPreference.mockClear();
    preferences.getPreference.mockResolvedValue(null);
    preferences.setPreference.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('asks to go monthly and links to /support tagged with its src', async () => {
    await renderBanner();

    expect(screen.getByText(tFromCatalog('marketing', 'home.supportBanner.text'))).toBeTruthy();
    const link = screen.getByText(tFromCatalog('marketing', 'home.supportBanner.cta')).closest('a');
    expect(link?.getAttribute('href')).toBe('/support?src=web-home-banner');
  });

  it('stays hidden for a visitor who closed it', async () => {
    preferences.getPreference.mockResolvedValue(true);
    await renderBanner();

    expect(screen.queryByTestId('home-support-banner')).toBeNull();
  });

  it('remembers a close in IndexedDB', async () => {
    await renderBanner();

    fireEvent.click(screen.getByLabelText(tFromCatalog('marketing', 'home.supportBanner.close')));

    expect(preferences.setPreference).toHaveBeenCalledWith('supportBanner:december2026:dismissed', true);
  });

  // A homepage held in a cache past 31 Dec must not show it.
  it('shows nothing once the browser clock is past the window', async () => {
    vi.setSystemTime(new Date('2027-01-02T09:00:00Z'));
    await renderBanner();

    expect(screen.queryByTestId('home-support-banner')).toBeNull();
    expect(preferences.getPreference).not.toHaveBeenCalledWith('supportBanner:december2026:dismissed');
  });
});
