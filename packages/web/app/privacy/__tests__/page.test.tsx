import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { render, screen } from '@testing-library/react';
import { tFromCatalog } from '@/app/__test-helpers__/i18n-mock';

vi.mock('@/app/lib/i18n/server', () => ({
  getServerTranslation: async (namespace: string) => ({
    t: (key: string, options?: Record<string, unknown>) => tFromCatalog(namespace, key, options),
    locale: 'en-US',
  }),
}));

const { default: PrivacyPolicyPage } = await import('../page');

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
    expect(screen.getByText(/not the climb’s name or the Spraywall’s name/)).toBeTruthy();
    // Every password write ends connections (the user_credentials trigger), not only a reset.
    expect(screen.getByText(/Any change to your password, including resetting it or setting one/)).toBeTruthy();
    expect(screen.getByText(/does not delete what the app already copied/)).toBeTruthy();
  });
});
