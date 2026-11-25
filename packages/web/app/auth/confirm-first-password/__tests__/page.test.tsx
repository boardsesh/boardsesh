import { describe, expect, it, vi } from 'vite-plus/test';

vi.mock('server-only', () => ({}));
const mocks = vi.hoisted(() => ({ mode: vi.fn() }));
vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('NOT_FOUND');
  },
}));
vi.mock('@/app/lib/auth/browser-session-mode.server', () => ({ browserSessionRouteMode: mocks.mode }));
vi.mock('@/app/lib/i18n/server', () => ({
  getServerTranslation: async () => ({ t: (key: string) => key, locale: 'en-US' }),
}));
vi.mock('@/app/lib/i18n/get-locale', () => ({ getLocale: async () => 'en-US' }));
vi.mock('@/app/components/providers/i18n-provider', () => ({
  default: ({ children }: { children: unknown }) => children,
}));
vi.mock('../confirm-first-password-content', () => ({ default: () => null }));

const { default: ConfirmFirstPasswordPage, generateMetadata } =
  await import('@/app/(site)/auth/confirm-first-password/page');

describe('the first-password confirmation page (#7596 B5e2)', () => {
  it.each(['legacy', 'unavailable'])('is a 404 with the browser session mode %s', async (kind) => {
    mocks.mode.mockReturnValue({ kind });
    await expect(ConfirmFirstPasswordPage()).rejects.toThrow('NOT_FOUND');
  });

  it('renders under better-auth and is a utility page', async () => {
    mocks.mode.mockReturnValue({ kind: 'better-auth' });
    await expect(ConfirmFirstPasswordPage()).resolves.toBeTruthy();
    expect((await generateMetadata()).robots).toEqual({ index: false, follow: true });
  });
});
