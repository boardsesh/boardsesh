// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const control = vi.hoisted(() => ({
  token: vi.fn(),
  query: vi.fn(),
  redirect: vi.fn((destination: string): never => {
    throw new Error(`REDIRECT:${destination}`);
  }),
  notFound: vi.fn((): never => {
    throw new Error('NOT_FOUND');
  }),
}));
vi.mock('server-only', () => ({}));
vi.mock('next/navigation', () => ({
  redirect: control.redirect,
  permanentRedirect: control.redirect,
  notFound: control.notFound,
}));
vi.mock('@/app/lib/auth/server-auth', () => ({ getServerAuthToken: control.token }));
vi.mock('@/app/lib/graphql/server-graphql', () => ({ executeAuthenticatedGraphQL: control.query }));
vi.mock('@/app/lib/i18n/get-locale', () => ({ getLocale: async () => 'en-US' }));
vi.mock('@/app/lib/i18n/server', () => ({
  getServerTranslation: async () => ({ locale: 'en-US', t: (key: string) => key }),
}));
vi.mock('@/app/lib/seo/metadata', () => ({ createNoIndexMetadata: (metadata: unknown) => metadata }));
vi.mock('@/app/components/providers/i18n-provider', () => ({ default: 'test-i18n' }));
vi.mock('../manage-gym-content', () => ({ default: 'manage-gym-content' }));
import ManageGymPage, { generateMetadata } from '../page';

const privateGym = {
  uuid: 'private-gym',
  slug: 'test-gym',
  name: 'Test gym',
  canEdit: true,
  isPublic: false,
};
function props() {
  return { params: Promise.resolve({ gym_slug: 'test-gym' }), searchParams: Promise.resolve({ tab: 'members' }) };
}
beforeEach(() => {
  vi.clearAllMocks();
  control.token.mockResolvedValue('editor-token');
  control.query.mockResolvedValue({ gymBySlug: privateGym });
});

describe('gym management page and the signed-in editor', () => {
  it('renders the editor view and hides a private gym from non-editors', async () => {
    const page = await ManageGymPage(props());
    expect(page.props.children.type).toBe('manage-gym-content');
    expect(page.props.children.props.initialGym).toEqual(privateGym);
    control.query.mockResolvedValue({ gymBySlug: { ...privateGym, canEdit: false } });
    await expect(ManageGymPage(props())).rejects.toThrow('NOT_FOUND');
  });

  it('names the gym in the title only for its editors', async () => {
    expect((await generateMetadata(props())).title).toBe('manage.title');
    control.query.mockResolvedValue({ gymBySlug: { ...privateGym, canEdit: false } });
    expect((await generateMetadata(props())).title).toBe('metadata.fallbackTitle');
  });

  it('sends signed-out visitors to sign-in without reading the gym', async () => {
    control.token.mockResolvedValue(undefined);
    await expect(ManageGymPage(props())).rejects.toThrow('REDIRECT:/auth/login?callbackUrl=%2Fgym%2Ftest-gym%2Fmanage');
    expect((await generateMetadata(props())).title).toBe('metadata.fallbackTitle');
    expect(control.query).not.toHaveBeenCalled();
  });

  it('fails the render instead of redirecting when the credential authority is unavailable', async () => {
    control.token.mockRejectedValue(new Error('AUTHORITY_UNAVAILABLE'));
    await expect(ManageGymPage(props())).rejects.toThrow('AUTHORITY_UNAVAILABLE');
    await expect(generateMetadata(props())).rejects.toThrow('AUTHORITY_UNAVAILABLE');
    expect(control.redirect).not.toHaveBeenCalled();
    expect(control.query).not.toHaveBeenCalled();
  });
});
