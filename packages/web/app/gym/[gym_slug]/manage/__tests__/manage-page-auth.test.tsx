// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const control = vi.hoisted(() => ({
  token: vi.fn(),
  query: vi.fn(),
  mcpAvailable: vi.fn(),
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
vi.mock('../manage-no-access', () => ({ default: 'manage-no-access' }));
vi.mock('@/app/lib/directory-reports/directory-reports-flag', () => ({ isDirectoryReportsEnabled: async () => true }));
vi.mock('@/app/lib/gym-mcp/availability.server', () => ({ getGymMcpAvailability: control.mcpAvailable }));
import { GET_GYM_PENDING_CLAIM } from '@boardsesh/graphql/operations';
import ManageGymPage, { generateMetadata } from '@/app/(site)/gym/[gym_slug]/manage/page';

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
  control.mcpAvailable.mockResolvedValue({ enabled: false, invitationRequired: false });
});

describe('gym management page and the signed-in editor', () => {
  it('uses backend rollout state to expose assistant setup', async () => {
    const disabledPage = await ManageGymPage(props());
    expect(disabledPage.props.children.props.aiAssistantsAvailable).toBe(false);
    control.mcpAvailable.mockResolvedValue({ enabled: true, invitationRequired: true });
    const enabledPage = await ManageGymPage(props());
    expect(enabledPage.props.children.props.aiAssistantsAvailable).toBe(true);
    expect(enabledPage.props.children.props.aiAssistantsInvitationRequired).toBe(true);
  });
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

describe('the lock state for a climber who can claim the gym', () => {
  const publicGym = { ...privateGym, isPublic: true, canEdit: false, canClaim: true };
  const pending = { id: 'claim-1', method: 'admin', createdAt: '2026-11-20T10:00:00.000Z' };

  function answer(myPendingClaim: unknown) {
    control.query.mockImplementation(async (document: unknown) =>
      document === GET_GYM_PENDING_CLAIM
        ? { gymBySlug: { uuid: 'private-gym', myPendingClaim } }
        : { gymBySlug: publicGym },
    );
  }

  it('hands the lock state the claim already in flight', async () => {
    answer(pending);
    const page = await ManageGymPage(props());
    const lockState = page.props.children.props.children;
    expect(lockState.type).toBe('manage-no-access');
    expect(lockState.props.pendingClaim).toEqual(pending);
  });

  it('hands it none when there is none, or when asking fails', async () => {
    answer(null);
    expect((await ManageGymPage(props())).props.children.props.children.props.pendingClaim).toBeNull();

    control.query.mockImplementation(async (document: unknown) => {
      if (document === GET_GYM_PENDING_CLAIM) throw new Error('Cannot query field myPendingClaim');
      return { gymBySlug: publicGym };
    });
    expect((await ManageGymPage(props())).props.children.props.children.props.pendingClaim).toBeNull();
  });

  it("doesn't ask for a claim where the viewer has no Claim button", async () => {
    control.query.mockResolvedValue({ gymBySlug: { ...publicGym, canClaim: false } });
    await ManageGymPage(props());
    expect(control.query.mock.calls.some(([document]) => document === GET_GYM_PENDING_CLAIM)).toBe(false);
  });

  it("doesn't ask on a gym its staff run, even when canClaim says yes", async () => {
    control.query.mockImplementation(async (document: unknown) =>
      document === GET_GYM_PENDING_CLAIM
        ? { gymBySlug: { uuid: 'private-gym', myPendingClaim: pending } }
        : { gymBySlug: { ...publicGym, listingState: 'RUN_BY_GYM' } },
    );
    const page = await ManageGymPage(props());
    expect(control.query.mock.calls.some(([document]) => document === GET_GYM_PENDING_CLAIM)).toBe(false);
    expect(page.props.children.props.children.props.pendingClaim).toBeNull();
  });
});
