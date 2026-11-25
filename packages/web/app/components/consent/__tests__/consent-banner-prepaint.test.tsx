import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { serializeConsentCookieValue } from '@boardsesh/consent';
import { CONSENT_PREPAINT_SCRIPT, refreshWebConsent } from '@/app/lib/consent';
import { ConsentStateProvider, useConsent } from '../consent-state-provider';
import ConsentBanner from '../consent-banner';

const dialog = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/app/lib/i18n/use-locale-router', () => ({ usePathnameWithoutLocale: () => '/' }));
vi.mock('@/app/components/i18n/locale-link', () => ({
  default: ({ href, children }: { href: string; children?: React.ReactNode }) => <a href={href}>{children}</a>,
}));
vi.mock('../use-consent-region-prompt', () => ({
  useConsentRegionPromptState: () => ({ prompt: true, settled: true }),
}));
vi.mock('../consent-choices-loader', () => ({ loadConsentChoicesDialog: dialog.load }));
vi.mock('@/app/lib/consent-pending-db', () => ({
  loadPendingConsent: async () => null,
  persistPendingConsent: async () => {},
}));

const productionStyles = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../index.css'), 'utf8');
let stylesheet: HTMLStyleElement;

function PrivacyChoicesTrigger() {
  const { openChoices } = useConsent();
  return <button onClick={openChoices}>open-privacy-choices</button>;
}

beforeEach(() => {
  dialog.load.mockReset();
});
afterEach(() => {
  cleanup();
  stylesheet?.remove();
  document.cookie = 'boardsesh-consent=; Max-Age=0; Path=/';
  refreshWebConsent();
  delete document.documentElement.dataset.consent;
});

describe('explicit privacy choices with production pre-paint hiding', () => {
  it.each([
    ['granted', 'pending'],
    ['denied', 'pending'],
    ['granted', 'rejected'],
    ['denied', 'rejected'],
  ] as const)(
    'keeps choices visible after saved %s when the dialog download is %s',
    async (previousChoice, download) => {
      document.cookie = `boardsesh-consent=${serializeConsentCookieValue({ analytics: previousChoice, version: 1, source: 'web', decidedAt: '2026-11-25T00:00:00.000Z' })}; Path=/`;
      refreshWebConsent();
      runInNewContext(CONSENT_PREPAINT_SCRIPT, { document });
      expect(document.documentElement.dataset.consent).toBe(previousChoice);
      if (download === 'pending') dialog.load.mockImplementation(() => new Promise(() => {}));
      else dialog.load.mockRejectedValue(new Error('offline'));
      render(
        <ConsentStateProvider auth={{ accountId: null, status: 'unauthenticated', token: null }}>
          <PrivacyChoicesTrigger />
          <ConsentBanner />
        </ConsentStateProvider>,
      );
      stylesheet = document.createElement('style');
      stylesheet.textContent = productionStyles;
      document.head.append(stylesheet);
      // The real stylesheet must suppress the automatic cached prompt for an answered cookie.
      expect(getComputedStyle(screen.getByTestId('consent-banner')).display).toBe('none');

      fireEvent.click(screen.getByRole('button', { name: 'open-privacy-choices' }));
      await act(async () => {});
      const choices = screen.getByRole('region', { name: 'privacyChoices' });
      expect(getComputedStyle(choices).display).not.toBe('none');
      expect(screen.getByRole('link', { name: 'privacyLink' }).getAttribute('href')).toBe('/privacy');
      expect(screen.getByText('adMeasurement')).toBeTruthy();
      const nextChoice = previousChoice === 'granted' ? 'denied' : 'granted';
      fireEvent.click(screen.getByRole('button', { name: nextChoice === 'denied' ? 'deny' : 'allow' }));
      await waitFor(() => expect(document.cookie).toContain(`v1.${nextChoice}.`));
      expect(document.documentElement.dataset.consent).toBe(nextChoice);
      expect(getComputedStyle(screen.getByTestId('consent-banner')).display).toBe('none');
    },
  );
});
