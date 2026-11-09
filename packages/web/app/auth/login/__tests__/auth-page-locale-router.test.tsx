/**
 * The login page through the real locale router. `applyLocale` strips a leading
 * locale segment, so a value that looks harmless to the helper can come out of
 * the router as `//host`. The page's other dependencies are stubbed; the router
 * and its rewrite are not.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import React from 'react';
import { render, waitFor } from '@testing-library/react';
import { tFromCatalog } from '@/app/__test-helpers__/i18n-mock';

const { i18nState, navigationState, nextRouter } = vi.hoisted(() => ({
  i18nState: { language: 'en-US' },
  navigationState: { searchParams: new URLSearchParams() },
  nextRouter: { push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() },
}));

vi.mock('react-i18next', () => ({
  useTranslation: (ns?: string) => ({
    t: (key: string, options?: Record<string, unknown>) => tFromCatalog(ns, key, options),
    i18n: { language: i18nState.language },
  }),
  Trans: ({ children }: { children?: React.ReactNode }) => children ?? null,
}));

vi.mock('next-auth/react', () => ({
  getSession: vi.fn().mockResolvedValue(null),
  signIn: vi.fn(),
  useSession: () => ({ status: 'authenticated', data: null }),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => nextRouter,
  usePathname: () => '/auth/login',
  useSearchParams: () => navigationState.searchParams,
}));

vi.mock('@/app/components/auth/social-login-buttons', () => ({
  default: () => null,
}));

vi.mock('@/app/components/providers/snackbar-provider', () => ({
  useSnackbar: () => ({ showMessage: vi.fn() }),
}));

vi.mock('@/app/lib/analytics', () => ({
  track: vi.fn(),
  setPersonProperties: vi.fn(),
}));

const { default: AuthPageContent } = await import('../auth-page-content');

function openLoginPage(query: string) {
  navigationState.searchParams = new URLSearchParams(query);
  render(<AuthPageContent />);
}

describe('AuthPageContent — through the real locale router', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    i18nState.language = 'en-US';
  });

  it.each([
    ['/es//evil.example', 'callbackUrl=/es//evil.example'],
    ['/fr//', 'callbackUrl=/fr//'],
    ['/de//', 'callbackUrl=/de//'],
    ['/it//', 'callbackUrl=/it//'],
    ['/es/fr//evil.example', 'callbackUrl=/es/fr//evil.example'],
    ['/es/\\evil.example', 'callbackUrl=/es/%5Cevil.example'],
    ['/.//evil.example', 'callbackUrl=/.//evil.example'],
    ['/..//evil.example', 'callbackUrl=/..//evil.example'],
    ['/%2e//evil.example', 'callbackUrl=/%252e//evil.example'],
  ])('sends %s to / instead of letting the router expose //', async (_label, query) => {
    openLoginPage(query);
    await waitFor(() => expect(nextRouter.push).toHaveBeenCalled());
    expect(nextRouter.push.mock.calls).toEqual([['/']]);
  });

  it('still applies the visitor locale to a real return path', async () => {
    i18nState.language = 'es';
    openLoginPage('callbackUrl=/gym/bloclab/manage');
    await waitFor(() => expect(nextRouter.push).toHaveBeenCalled());
    expect(nextRouter.push.mock.calls).toEqual([['/es/gym/bloclab/manage']]);
  });

  it('passes an absolute same-origin return URL straight through', async () => {
    const returnUrl = `${window.location.origin}/gym/bloclab/manage?claim=1`;
    openLoginPage(new URLSearchParams({ callbackUrl: returnUrl }).toString());
    await waitFor(() => expect(nextRouter.push).toHaveBeenCalled());
    expect(nextRouter.push.mock.calls).toEqual([[returnUrl]]);
  });
});
