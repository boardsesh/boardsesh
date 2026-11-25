import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';

vi.mock('server-only', () => ({}));
const mocks = vi.hoisted(() => ({ session: vi.fn(), mode: vi.fn() }));
vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('NOT_FOUND');
  },
  redirect: (href: string) => {
    throw new Error(`REDIRECT:${href}`);
  },
}));
vi.mock('@/app/lib/auth/admitted-session.server', () => ({ getAdmittedServerSession: mocks.session }));
vi.mock('@/app/lib/auth/browser-session-mode.server', () => ({ browserSessionRouteMode: mocks.mode }));
vi.mock('@/app/lib/i18n/server', () => ({
  getServerTranslation: async () => ({ t: (key: string) => key, locale: 'en-US' }),
}));
vi.mock('@/app/lib/i18n/get-locale', () => ({ getLocale: async () => 'en-US' }));
vi.mock('@/app/components/providers/i18n-provider', () => ({
  default: ({ children }: { children: unknown }) => children,
}));
vi.mock('../first-password-content', () => ({ default: () => null }));

const { default: FirstPasswordPage, generateMetadata } = await import('@/app/(site)/settings/first-password/page');

beforeEach(() => {
  mocks.mode.mockReset().mockReturnValue({ kind: 'better-auth' });
  mocks.session.mockReset().mockResolvedValue({ user: { id: 'climber', email: 'climber@example.test' } });
});

describe('the first-password page (#7596 B5e2)', () => {
  it.each(['legacy', 'unavailable'])('is a 404 with the browser session mode %s', async (kind) => {
    mocks.mode.mockReturnValue({ kind });
    await expect(FirstPasswordPage()).rejects.toThrow('NOT_FOUND');
  });

  it('sends a signed-out browser to the login page, coming back here', async () => {
    mocks.session.mockResolvedValue(null);
    await expect(FirstPasswordPage()).rejects.toThrow(
      `REDIRECT:/auth/login?${new URLSearchParams({ callbackUrl: '/settings/first-password' }).toString()}`,
    );
  });

  it('is a utility page: noindex, follow', async () => {
    expect((await generateMetadata()).robots).toEqual({ index: false, follow: true });
  });
});
