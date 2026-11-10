import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { render, screen } from '@testing-library/react';
import { PARTNER_DEVELOPER_TERMS_VERSION } from '@boardsesh/auth-protocol/partner-oauth';
import { tFromCatalog } from '@/app/__test-helpers__/i18n-mock';

vi.mock('server-only', () => ({}));
const mocks = vi.hoisted(() => ({
  session: vi.fn(),
  flag: vi.fn(),
  locale: { current: 'en-US' },
}));
vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('NOT_FOUND');
  },
  redirect: (href: string) => {
    throw new Error(`REDIRECT:${href}`);
  },
}));
vi.mock('@/app/lib/auth/admitted-session.server', () => ({ getAdmittedServerSession: mocks.session }));
vi.mock('@/app/lib/feature-flags/server-feature-flag', () => ({ getServerFeatureFlag: mocks.flag }));
vi.mock('@/app/lib/i18n/server', () => ({
  getServerTranslation: async (namespace: string) => ({
    t: (key: string, options?: Record<string, unknown>) => tFromCatalog(namespace, key, options),
    locale: mocks.locale.current,
  }),
}));

const { default: DeveloperTermsPage, generateMetadata } = await import('../page');

beforeEach(() => {
  mocks.locale.current = 'en-US';
  mocks.session.mockReset().mockResolvedValue({ user: { id: 'developer-account' } });
  mocks.flag.mockReset().mockResolvedValue(true);
});

describe('developer terms page', () => {
  it('shows the terms behind the console flag, marked as a draft, with the version registration records', async () => {
    const { container } = render(await DeveloperTermsPage());
    expect(mocks.flag).toHaveBeenCalledWith('developer-console', { distinctId: 'developer-account' });
    expect(screen.getByRole('heading', { name: 'Boardsesh developer terms' })).toBeTruthy();
    expect(screen.getByText('Draft, not in force')).toBeTruthy();
    expect(screen.getByText(`Version ${PARTNER_DEVELOPER_TERMS_VERSION}`)).toBeTruthy();
    for (const heading of [
      'Climbers’ data',
      'Using the API',
      'Names and trademarks',
      'What Boardsesh may do',
      'Stopping',
    ]) {
      expect(screen.getByRole('heading', { name: heading })).toBeTruthy();
    }
    expect(screen.getByText(/including a draft or an unlisted climb someone else set/)).toBeTruthy();
    // Every line resolved to catalog text: no key printed in its place.
    expect(container.textContent).not.toMatch(/terms\.[a-z]/);
  });

  it('is a 404 when the flag is off', async () => {
    mocks.flag.mockResolvedValue(false);
    await expect(DeveloperTermsPage()).rejects.toThrow('NOT_FOUND');
  });

  it('sends a signed-out visitor to sign in first, keeping the locale', async () => {
    mocks.locale.current = 'fr';
    mocks.session.mockResolvedValue(null);
    await expect(DeveloperTermsPage()).rejects.toThrow(
      `REDIRECT:/fr/auth/login?callbackUrl=${encodeURIComponent('/fr/developers/terms')}`,
    );
    expect(mocks.flag).not.toHaveBeenCalled();
  });

  it('is a utility page: noindex, follow', async () => {
    const metadata = await generateMetadata();
    expect(metadata.robots).toEqual({ index: false, follow: true });
    expect(metadata.alternates?.canonical).toBe('/developers/terms');
  });
});
