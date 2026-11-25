import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { serializeConsentCookieValue } from '@boardsesh/consent';
import { ConsentStateProvider, useConsent } from '../../consent/consent-state-provider';
import { refreshWebConsent } from '@/app/lib/consent';
import ChineseTranslationOnboarding from '../chinese-translation-onboarding';

const mocks = vi.hoisted(() => ({ getPreference: vi.fn(), loadDialog: vi.fn() }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'zh-CN' } }),
}));
vi.mock('@/app/lib/i18n/use-locale-router', () => ({ usePathnameWithoutLocale: () => '/' }));
vi.mock('@/app/lib/user-preferences-db', () => ({ getPreference: mocks.getPreference, setPreference: vi.fn() }));
vi.mock('@/app/lib/consent-pending-db', () => ({
  loadPendingConsent: async () => null,
  persistPendingConsent: async () => {},
}));
vi.mock('../chinese-translation-dialog-loader', () => ({ loadChineseTranslationDialog: mocks.loadDialog }));

function AccountProbe() {
  const { snapshot, accountReady } = useConsent();
  return (
    <output data-testid="account-readiness">
      {String(snapshot.accountResolved)}:{String(accountReady)}
    </output>
  );
}

function Welcome({ status }: { status: 'loading' | 'unauthenticated' }) {
  return (
    <ConsentStateProvider auth={{ status, accountId: null, token: null }}>
      <AccountProbe />
      <ChineseTranslationOnboarding consentRegion={{ prompt: false, settled: true }} />
    </ConsentStateProvider>
  );
}

beforeEach(() => {
  mocks.getPreference.mockReset().mockResolvedValue(null);
  mocks.loadDialog.mockReset().mockResolvedValue({ default: () => <div role="dialog" /> });
  document.cookie = `boardsesh-consent=${serializeConsentCookieValue({ analytics: 'granted', version: 1, source: 'web', decidedAt: '2026-11-25T00:00:00.000Z' })}; Path=/`;
  refreshWebConsent();
});
afterEach(() => {
  cleanup();
  document.cookie = 'boardsesh-consent=; Max-Age=0; Path=/';
  refreshWebConsent();
});

describe('Chinese welcome account readiness', () => {
  it('waits for the real loading account gate despite a stored grant and resolved null coordinator', async () => {
    const view = render(<Welcome status="loading" />);
    expect(screen.getByTestId('account-readiness').textContent).toBe('true:false');
    expect(mocks.getPreference).not.toHaveBeenCalled();
    expect(mocks.loadDialog).not.toHaveBeenCalled();
    view.rerender(<Welcome status="unauthenticated" />);
    await waitFor(() => expect(screen.getByTestId('account-readiness').textContent).toBe('true:true'));
    await screen.findByRole('dialog');
    expect(mocks.getPreference).toHaveBeenCalledOnce();
    expect(mocks.loadDialog).toHaveBeenCalledOnce();
  });
});
