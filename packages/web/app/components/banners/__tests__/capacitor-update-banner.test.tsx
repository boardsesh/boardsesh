import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';
import { CapacitorUpdateBanner } from '../capacitor-update-banner';
import { isNativeApp, getPlatform } from '@/app/lib/ble/capacitor-utils';
import { isUpdateBannerSnoozed, snoozeUpdateBanner } from '@/app/lib/capacitor-update-banner-db';
import { openExternalUrl } from '@/app/lib/open-external-url';
import { useFeatureFlag } from '@/app/components/providers/feature-flags-provider';
import { tFromCatalog } from '@/app/__test-helpers__/i18n-mock';

vi.mock('react-i18next', () => ({
  useTranslation: (ns?: string) => ({
    t: (key: string, options?: Record<string, unknown>) => tFromCatalog(ns, key, options),
    i18n: { language: 'en-US' },
  }),
  Trans: ({ children }: { children?: React.ReactNode }) => children ?? null,
}));

// store-urls is left real so the test asserts the actual scheme URL the CTA opens.
vi.mock('@/app/lib/ble/capacitor-utils', () => ({
  isNativeApp: vi.fn().mockReturnValue(true),
  getPlatform: vi.fn().mockReturnValue('ios'),
}));
vi.mock('@/app/lib/capacitor-update-banner-db', () => ({
  isUpdateBannerSnoozed: vi.fn().mockResolvedValue(false),
  snoozeUpdateBanner: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/app/lib/open-external-url', () => ({
  openExternalUrl: vi.fn(),
}));
vi.mock('@/app/components/providers/feature-flags-provider', () => ({
  useFeatureFlag: vi.fn().mockReturnValue(true),
}));

const mockedIsNativeApp = vi.mocked(isNativeApp);
const mockedGetPlatform = vi.mocked(getPlatform);
const mockedIsSnoozed = vi.mocked(isUpdateBannerSnoozed);
const mockedSnooze = vi.mocked(snoozeUpdateBanner);
const mockedOpenExternalUrl = vi.mocked(openExternalUrl);
const mockedUseFeatureFlag = vi.mocked(useFeatureFlag);

const TITLE = 'Time to update Boardsesh';

describe('CapacitorUpdateBanner — gating', () => {
  beforeEach(() => {
    mockedIsNativeApp.mockReset().mockReturnValue(true);
    mockedGetPlatform.mockReset().mockReturnValue('ios');
    mockedIsSnoozed.mockReset().mockResolvedValue(false);
    mockedSnooze.mockReset().mockResolvedValue(undefined);
    mockedOpenExternalUrl.mockReset();
    mockedUseFeatureFlag.mockReset().mockReturnValue(true);
  });

  it('shows the banner inside the Capacitor app when the flag is on', async () => {
    render(<CapacitorUpdateBanner />);
    expect(await screen.findByText(TITLE)).toBeTruthy();
  });

  it('stays hidden when the flag is off (default for non-targeted users)', async () => {
    mockedUseFeatureFlag.mockReturnValue(undefined);
    render(<CapacitorUpdateBanner />);
    // The flag gate short-circuits before the snooze lookup runs.
    await waitFor(() => expect(mockedIsSnoozed).not.toHaveBeenCalled());
    expect(screen.queryByText(TITLE)).toBeNull();
  });

  it('stays hidden outside the Capacitor app even with the flag on', async () => {
    mockedIsNativeApp.mockReturnValue(false);
    render(<CapacitorUpdateBanner />);
    await waitFor(() => expect(mockedIsSnoozed).not.toHaveBeenCalled());
    expect(screen.queryByText(TITLE)).toBeNull();
  });

  it('stays hidden while snoozed', async () => {
    mockedIsSnoozed.mockResolvedValue(true);
    render(<CapacitorUpdateBanner />);
    await waitFor(() => expect(mockedIsSnoozed).toHaveBeenCalled());
    expect(screen.queryByText(TITLE)).toBeNull();
  });

  it('opens the platform-correct store URL when the CTA is tapped', async () => {
    mockedGetPlatform.mockReturnValue('android');
    render(<CapacitorUpdateBanner />);
    fireEvent.click(await screen.findByRole('button', { name: 'Update now' }));
    expect(mockedOpenExternalUrl).toHaveBeenCalledWith('market://details?id=com.boardsesh.app');
  });

  it('snoozes and hides when dismissed', async () => {
    render(<CapacitorUpdateBanner />);
    fireEvent.click(await screen.findByRole('button', { name: 'Dismiss update reminder' }));
    expect(mockedSnooze).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByText(TITLE)).toBeNull());
  });
});
