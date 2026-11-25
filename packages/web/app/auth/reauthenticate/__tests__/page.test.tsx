import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';

vi.mock('server-only', () => ({}));
const mocks = vi.hoisted(() => ({ session: vi.fn(), mode: vi.fn(), content: vi.fn() }));
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
vi.mock('../reauthenticate-content', () => ({ default: mocks.content }));

const { default: ReauthenticatePage, generateMetadata } = await import('@/app/(site)/auth/reauthenticate/page');

const searchParams = (params: Record<string, string>) => ({ searchParams: Promise.resolve(params) });

beforeEach(() => {
  mocks.mode.mockReset().mockReturnValue({ kind: 'better-auth' });
  mocks.session.mockReset().mockResolvedValue({ user: { id: 'climber', email: 'climber@example.test' } });
});

describe('the forced re-sign-in page (#7655 item 6)', () => {
  it.each(['legacy', 'unavailable'])('is a 404 when the browser session mode is %s', async (kind) => {
    mocks.mode.mockReturnValue({ kind });
    await expect(ReauthenticatePage(searchParams({ callbackUrl: '/developers/apps' }))).rejects.toThrow('NOT_FOUND');
    expect(mocks.session).not.toHaveBeenCalled();
  });

  it('sends a signed-out browser to the login page, coming back here', async () => {
    mocks.session.mockResolvedValue(null);
    const here = `/auth/reauthenticate?${new URLSearchParams({ callbackUrl: '/developers/apps' }).toString()}`;
    await expect(ReauthenticatePage(searchParams({ callbackUrl: '/developers/apps' }))).rejects.toThrow(
      `REDIRECT:/auth/login?${new URLSearchParams({ callbackUrl: here }).toString()}`,
    );
  });

  it('reduces the return path to this site and passes only known outcomes on', async () => {
    const page = (await ReauthenticatePage(
      searchParams({ callbackUrl: 'https://evil.example/', outcome: 'other_account' }),
    )) as { props: { children: { props: { children: { props: Record<string, unknown> } } } } };
    expect(page.props.children.props.children.props).toEqual({
      email: 'climber@example.test',
      callbackUrl: '/',
      outcome: 'other_account',
    });
    const unknown = (await ReauthenticatePage(searchParams({ callbackUrl: '/x', outcome: 'anything' }))) as {
      props: { children: { props: { children: { props: Record<string, unknown> } } } };
    };
    expect(unknown.props.children.props.children.props.outcome).toBeUndefined();
  });

  it('is a utility page: noindex, follow', async () => {
    expect((await generateMetadata()).robots).toEqual({ index: false, follow: true });
  });
});
