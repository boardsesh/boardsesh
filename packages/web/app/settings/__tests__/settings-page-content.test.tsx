/**
 * W-21 (#4440): `/settings` is scoped down to the two things only the web can
 * do — register an ESP32 controller and set a first password for an OAuth-only
 * account — plus a hand-off to the app for everything else.
 *
 * This is the oracle for the issue's headline Verifies row. The dropped blocks
 * (profile form, grade-format toggle, logbook shortcut, board accounts, watch
 * pairing, delete account) each leave a distinctive DOM fingerprint, so the
 * assertions below are shaped to red the moment one of them is rendered again.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { tFromCatalog } from '@/app/__test-helpers__/i18n-mock';

// Hand-written rather than rebuilt from `APP_URL`: an expectation assembled the
// same way as the code under test cannot catch a malformed URL. Safe to pin
// because `NEXT_PUBLIC_APP_URL` is unset under vitest, so the origin resolves to
// the shared prod default (same premise as middleware.test.ts:617).
const EXPECTED_HANDOFF_HREF = 'https://app.boardsesh.com/profile/more';

vi.mock('react-i18next', () => ({
  useTranslation: (ns?: string) => ({
    t: (key: string, options?: Record<string, unknown>) => tFromCatalog(ns, key, options),
    i18n: { language: 'en-US' },
  }),
  Trans: ({ children }: { children?: React.ReactNode }) => children ?? null,
}));

vi.mock('server-only', () => ({}));

const mockShowMessage = vi.fn();
vi.mock('@/app/components/providers/snackbar-provider', () => ({
  useSnackbar: () => ({ showMessage: mockShowMessage }),
}));

const mockPush = vi.fn();
vi.mock('@/app/lib/i18n/use-locale-router', () => ({
  useLocaleRouter: () => ({ push: mockPush, replace: vi.fn(), prefetch: vi.fn(), back: vi.fn() }),
}));

vi.mock('next-auth/react', () => ({
  useSession: () => ({
    data: { user: { id: 'u1', email: 'climber@example.com' } },
    status: 'authenticated',
    update: vi.fn(),
  }),
}));

// The two kept sections are stubbed so this file asserts what the page renders,
// not what they render. Both carry their own render coverage —
// `components/account/__tests__/set-password-section.test.tsx` and
// `components/account/__tests__/controllers-section.test.tsx`.
vi.mock('@/app/components/account/controllers-section', () => ({
  default: () => <div data-testid="controllers-section" />,
}));

vi.mock('@/app/components/account/set-password-section', () => ({
  default: () => <div data-testid="set-password-section" />,
}));

import SettingsPageContent from '../settings-page-content';

beforeEach(() => {
  vi.clearAllMocks();
  global.fetch = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ email: 'climber@example.com', hasPassword: false, linkedProviders: ['google'] }),
  }) as unknown as typeof fetch;
});

async function renderSettings() {
  const utils = render(<SettingsPageContent />);
  await waitFor(() => {
    expect(utils.container.querySelector('[data-testid="set-password-section"]')).toBeTruthy();
  });
  return utils;
}

describe('SettingsPageContent', () => {
  it('renders the set-password and ESP32 controller sections', async () => {
    await renderSettings();

    expect(screen.getByTestId('set-password-section')).toBeTruthy();
    expect(screen.getByTestId('controllers-section')).toBeTruthy();
  });

  it('renders the page title', async () => {
    await renderSettings();

    expect(screen.getByText(tFromCatalog('settings', 'title'))).toBeTruthy();
  });

  it('renders no profile form fields', async () => {
    // The display-name / Instagram / email inputs moved to the app's edit-profile
    // screen. The stubs render no fields, so any input here is a regression.
    const { container } = await renderSettings();

    expect(container.querySelectorAll('input, textarea').length).toBe(0);
  });

  it('renders no grade-format toggle', async () => {
    // MUI's ToggleButtonGroup renders role="group".
    const { container } = await renderSettings();

    expect(container.querySelectorAll('[role="group"]').length).toBe(0);
  });

  it('renders no logbook shortcut', async () => {
    // Suffix match, not an exact one: `LocaleLink` prefixes the href with the
    // active locale, so `a[href="/playlists"]` would go quietly inert the day
    // this file's i18n mock exercises `es` / `fr` / `de`.
    const { container } = await renderSettings();

    expect(container.querySelectorAll('a[href$="/playlists"]').length).toBe(0);
  });

  it('renders no delete-account section', async () => {
    await renderSettings();

    expect(screen.queryByText(tFromCatalog('settings', 'deleteAccount.title'))).toBeNull();
  });

  it('renders no watch-pairing section', async () => {
    await renderSettings();

    expect(screen.queryByText(tFromCatalog('settings', 'watchPairing.title'))).toBeNull();
  });

  it('renders no board-accounts section', async () => {
    await renderSettings();

    expect(screen.queryByText(tFromCatalog('settings', 'aurora.title'))).toBeNull();
  });

  it('links to the app profile screen, and links nowhere else', async () => {
    // The destination is named explicitly rather than mirrored from this
    // pathname: the SPA has no /settings route, so the same-path form would be
    // a 404.
    //
    // Asserted as the page's whole href list, which is the "and nothing else"
    // half of the issue's Verifies row: a bound on the hand-off link alone lets
    // a re-added shortcut card pointing anywhere else slip past every assertion
    // in this file. Two links is the whole page — the header logo home link and
    // the hand-off CTA. BackButton is a <button>, so it is not in the list.
    const { container } = await renderSettings();

    const hrefs = Array.from(container.querySelectorAll('a')).map((anchor) => anchor.getAttribute('href'));
    expect(hrefs).toEqual(['/', EXPECTED_HANDOFF_HREF]);
    expect(screen.getByText(tFromCatalog('settings', 'appHandoff.cta'))).toBeTruthy();
  });

  it('surfaces a profile fetch failure instead of spinning forever', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) }) as unknown as typeof fetch;

    await renderSettings();

    expect(mockShowMessage).toHaveBeenCalledWith(tFromCatalog('settings', 'loading.profileError'), 'error');
  });
});
