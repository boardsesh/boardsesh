// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const control = vi.hoisted(() => ({
  viewer: vi.fn(),
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
vi.mock('@/app/lib/auth/admitted-session.server', () => ({ getServerRenderViewer: control.viewer }));
vi.mock('@/app/lib/auth/server-auth', () => ({ getServerAuthToken: control.token }));
vi.mock('@/app/lib/graphql/server-graphql', () => ({ executeAuthenticatedGraphQL: control.query }));
vi.mock('@/app/lib/i18n/get-locale', () => ({ getLocale: async () => 'en-US' }));
vi.mock('@/app/lib/i18n/server', () => ({
  getServerTranslation: async () => ({ locale: 'en-US', t: (key: string) => key }),
}));
vi.mock('@/app/lib/seo/metadata', () => ({ createNoIndexMetadata: (metadata: unknown) => metadata }));
vi.mock('@/app/components/providers/i18n-provider', () => ({ default: 'test-i18n' }));
vi.mock('../manage-gym-content', () => ({ default: 'legacy-private-gym' }));
vi.mock('../selected-manage-gym', () => ({ default: 'selected-client-gym' }));
import ManageGymPage, { generateMetadata } from '../page';

const owner = {
  userId: 'viewer-a',
  authSessionId: 'login-a',
  generation: 3,
  cursor: { bindingId: 'a'.repeat(64), version: 2 },
};
const privateGym = {
  uuid: 'private-gym',
  slug: 'test-gym',
  name: 'PRIVATE_GYM_NAME_SENTINEL',
  canEdit: true,
  isPublic: false,
  members: [{ email: 'PRIVATE_MEMBER_EMAIL_SENTINEL' }],
};
function props() {
  return { params: Promise.resolve({ gym_slug: 'test-gym' }), searchParams: Promise.resolve({ tab: 'members' }) };
}
beforeEach(() => {
  vi.clearAllMocks();
  control.viewer.mockResolvedValue({ kind: 'selected', owner });
  control.token.mockResolvedValue('PRIVATE_BEARER_SENTINEL');
  control.query.mockResolvedValue({ gymBySlug: privateGym });
});

describe('selected management pages send no viewer-private server payload', () => {
  it('sends only route and public owner metadata to the private client island', async () => {
    const page = await ManageGymPage(props());
    expect(page.props.children.type).toBe('selected-client-gym');
    expect(page.props.children.props).toEqual({ slugOrUuid: 'test-gym', owner });
    expect(JSON.stringify(page)).not.toContain('PRIVATE_');
    expect(control.token).not.toHaveBeenCalled();
    expect(control.query).not.toHaveBeenCalled();
  });

  it('uses generic selected metadata without requesting a private gym name', async () => {
    const metadata = await generateMetadata(props());
    expect(metadata.title).toBe('metadata.fallbackTitle');
    expect(JSON.stringify(metadata)).not.toContain('PRIVATE_');
    expect(control.token).not.toHaveBeenCalled();
    expect(control.query).not.toHaveBeenCalled();
  });

  it.each(['anonymous', 'refused'])(
    'redirects %s utility visitors without reading another cookie family',
    async (kind) => {
      control.viewer.mockResolvedValue({ kind });
      await expect(ManageGymPage(props())).rejects.toThrow('REDIRECT:/auth/login?callbackUrl=');
      expect(control.token).not.toHaveBeenCalled();
      expect(control.query).not.toHaveBeenCalled();
    },
  );

  it('preserves unavailable authority as an error instead of an anonymous redirect', async () => {
    control.viewer.mockRejectedValue(new Error('AUTHORITY_UNAVAILABLE'));
    await expect(ManageGymPage(props())).rejects.toThrow('AUTHORITY_UNAVAILABLE');
    expect(control.redirect).not.toHaveBeenCalled();
    expect(control.token).not.toHaveBeenCalled();
    expect(control.query).not.toHaveBeenCalled();
  });

  it('preserves existing legacy editor rendering and private gym denial', async () => {
    control.viewer.mockResolvedValue({ kind: 'legacy' });
    const page = await ManageGymPage(props());
    expect(page.props.children.type).toBe('legacy-private-gym');
    expect(page.props.children.props.initialGym).toEqual(privateGym);
    control.query.mockResolvedValue({ gymBySlug: { ...privateGym, canEdit: false } });
    await expect(ManageGymPage(props())).rejects.toThrow('NOT_FOUND');
  });
});
