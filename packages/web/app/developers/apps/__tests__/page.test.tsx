import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';

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
  getServerTranslation: async () => ({ t: (key: string) => key, locale: mocks.locale.current }),
}));
vi.mock('../developer-apps-content', () => ({ default: () => null }));

const { default: DeveloperAppsPage, generateMetadata } = await import('../page');

beforeEach(() => {
  mocks.locale.current = 'en-US';
  mocks.session.mockReset().mockResolvedValue({ user: { id: 'developer-account' } });
  mocks.flag.mockReset().mockResolvedValue(true);
});

describe('developer console page', () => {
  it('renders for a signed-in developer with the flag on, asking the flag about that developer', async () => {
    await expect(DeveloperAppsPage()).resolves.toBeTruthy();
    expect(mocks.flag).toHaveBeenCalledWith('developer-console', { distinctId: 'developer-account' });
  });

  it('is a 404 when the flag is off, which is also how an unreachable PostHog answers', async () => {
    mocks.flag.mockResolvedValue(false);
    await expect(DeveloperAppsPage()).rejects.toThrow('NOT_FOUND');
  });

  it('sends a signed-out visitor to sign in first, keeping the locale, and shows them nothing', async () => {
    mocks.locale.current = 'de';
    mocks.session.mockResolvedValue(null);
    await expect(DeveloperAppsPage()).rejects.toThrow(
      `REDIRECT:/de/auth/login?callbackUrl=${encodeURIComponent('/de/developers/apps')}`,
    );
    expect(mocks.flag).not.toHaveBeenCalled();
  });

  it('shows an error, not a sign-in loop, when the credential authority is down', async () => {
    mocks.session.mockRejectedValue(new Error('credential authority unavailable'));
    await expect(DeveloperAppsPage()).rejects.toThrow('credential authority unavailable');
    expect(mocks.flag).not.toHaveBeenCalled();
  });

  it('is a utility page: noindex, follow', async () => {
    const metadata = await generateMetadata();
    expect(metadata.robots).toEqual({ index: false, follow: true });
    expect(metadata.alternates?.canonical).toBe('/developers/apps');
  });
});
