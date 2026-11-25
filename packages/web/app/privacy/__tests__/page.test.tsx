import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { render, screen } from '@testing-library/react';
import { tFromCatalog } from '@/app/__test-helpers__/i18n-mock';

vi.mock('@/app/lib/i18n/server', () => ({
  getServerTranslation: async (namespace: string) => ({
    t: (key: string, options?: Record<string, unknown>) => tFromCatalog(namespace, key, options),
    locale: 'en-US',
  }),
}));

const { default: PrivacyPolicyPage } = await import('@/app/(site)/privacy/page');

beforeEach(() => {
  for (const name of [
    'STRIPE_DONATE_URL',
    'STRIPE_DONATE_URL_USD',
    'SUPPORT_MONTHLY_LINKS_AUD',
    'SUPPORT_MONTHLY_LINKS_USD',
  ]) {
    vi.stubEnv(name, '');
  }
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('privacy policy, apps you connect', () => {
  it('says nothing about connected apps while partner apps are off', async () => {
    vi.stubEnv('PARTNER_OAUTH_MODE', 'off');
    render(await PrivacyPolicyPage());
    expect(screen.queryByRole('heading', { name: 'Apps you connect' })).toBeNull();
  });

  it.each(['hold', 'allowlist', 'open'])('says what a connected app receives once the mode is %s', async (mode) => {
    vi.stubEnv('PARTNER_OAUTH_MODE', mode);
    render(await PrivacyPolicyPage());
    expect(screen.getByRole('heading', { name: 'Apps you connect' })).toBeTruthy();
    expect(screen.getByText(/including ticks you keep to “Only me”/)).toBeTruthy();
    expect(screen.getByText(/a climb someone else set that is still a draft or unlisted/)).toBeTruthy();
    expect(screen.getByText(/not the climb’s name or the spray wall’s name/)).toBeTruthy();
    // Every password write ends connections (the user_credentials trigger), not only a reset.
    expect(screen.getByText(/Any change to your password, including resetting it or setting one/)).toBeTruthy();
    expect(screen.getByText(/does not delete what the app already copied/)).toBeTruthy();
  });
});

describe('privacy policy, board accounts and payment availability', () => {
  it('names the operator and explains saved credentials and one-way imports', async () => {
    render(await PrivacyPolicyPage());
    expect(screen.getByText(/run by Marco de Jongh/)).toBeTruthy();
    expect(screen.getByText(/checks for new sends in the background/)).toBeTruthy();
    expect(screen.getByText(/Kilter.*encrypted sign-in token, not your Kilter password/)).toBeTruthy();
    expect(screen.getByText(/Unlink removes the saved credential/)).toBeTruthy();
    expect(screen.getByText(/Decoy, Touchstone, Grasshopper and So iLL/)).toBeTruthy();
    expect(screen.queryByText(/Party Mode/)).toBeNull();
  });

  it('does not describe Stripe as available without a configured card payment route', async () => {
    render(await PrivacyPolicyPage());
    expect(screen.queryByRole('link', { name: "Stripe's privacy policy" })).toBeNull();
  });

  it.each([
    ['STRIPE_DONATE_URL', 'https://donate.stripe.com/test_link'],
    ['SUPPORT_MONTHLY_LINKS_USD', '[{"label":"Monthly support","url":"https://buy.stripe.com/monthly"}]'],
  ])('discloses Stripe when %s provides a usable card payment route', async (name, configured) => {
    vi.stubEnv(name, configured);
    render(await PrivacyPolicyPage());
    expect(screen.getByRole('link', { name: "Stripe's privacy policy" })).toBeTruthy();
  });
});
