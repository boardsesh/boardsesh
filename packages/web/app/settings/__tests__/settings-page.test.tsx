import { describe, expect, it, vi } from 'vite-plus/test';

vi.mock('server-only', () => ({}));
const mocks = vi.hoisted(() => ({ mode: vi.fn() }));
vi.mock('@/app/lib/auth/browser-session-mode.server', () => ({ browserSessionRouteMode: mocks.mode }));
vi.mock('@/app/lib/i18n/server', () => ({
  getServerTranslation: async () => ({ t: (key: string) => key, locale: 'en-US' }),
}));
vi.mock('@/app/lib/i18n/get-locale', () => ({ getLocale: async () => 'en-US' }));
vi.mock('@/app/components/providers/i18n-provider', () => ({
  default: ({ children }: { children: unknown }) => children,
}));
vi.mock('../settings-page-content', () => ({ default: () => null }));

const { default: SettingsPage } = await import('../page');

type Rendered = { props: { children: { props: Record<string, unknown> } } };

describe('the www settings page', () => {
  it.each([
    ['legacy', false],
    ['unavailable', false],
    ['better-auth', true],
  ] as const)('with the browser session mode %s, passes signInMethods=%s', async (kind, expected) => {
    mocks.mode.mockReturnValue({ kind });
    const page = (await SettingsPage()) as Rendered;
    expect(page.props.children.props.signInMethods).toBe(expected);
  });
});
