// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdmittedBrowserSelection, PresentedBrowserSelection } from '../presented-browser-selection.server';
import type { getProfileData } from '@/app/profile/[user_id]/server-profile-data';
vi.mock('server-only', () => ({}));
vi.mock('@/app/profile/[user_id]/server-profile-data', () => ({
  getProfileData: () => {
    throw new Error('Implicit legacy profile access is forbidden');
  },
}));
import { createBrowserConsumerFacade } from '../browser-consumers.server';
import { createSelectedProfileResponse } from '../selected-profile-response.server';

function selected(): AdmittedBrowserSelection {
  return {
    status: 'admitted',
    bindingToken: 'A'.repeat(43),
    actor: { version: 2, credential: { kind: 'canonical-token', token: 'PRIVATE_SOURCE_TOKEN' } },
    cursor: { bindingId: 'a'.repeat(64), version: 2, bindingExpiresAt: '2099-01-01T00:00:00.000Z' },
    session: {
      userId: 'owner-a',
      authSessionId: 'login-a',
      generation: 3,
      authenticatedAt: null,
      expiresAt: '2098-01-01T00:00:00.000Z',
      linkGuarded: false,
      requiresAccountCutoff: true,
    },
    user: { id: 'owner-a', name: 'Climber', email: 'PRIVATE_CURRENT_EMAIL', image: null },
  };
}
const profile = {
  id: 'profile-owner',
  name: 'Climber',
  image: null,
  email: undefined,
  profile: null,
  credentials: [{ boardType: 'kilter', auroraUsername: 'PRIVATE_MAPPING' }],
  followerCount: 2,
  followingCount: 3,
  isFollowedByMe: false,
};
let current: AdmittedBrowserSelection;
let readSelection: ReturnType<typeof vi.fn<(cookies: string | null) => Promise<PresentedBrowserSelection>>>;
let readProfile: ReturnType<typeof vi.fn<typeof getProfileData>>;
function fixture(mode = 'backend-staging', ready = true) {
  const facade = createBrowserConsumerFacade({
    ready: () => ready,
    environment: () => ({ CURRENT_STORE_BROWSER_BINDING_MODE: mode }),
    readSelection,
    issueToken: async (observed) => ({
      status: 'admitted',
      token: 'bsbd1_PRIVATE_SHORT_LEASE',
      cursor: observed.cursor,
      userId: observed.session.userId,
      authSessionId: observed.session.authSessionId,
      usableForMs: 60_000,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }),
  });
  return createSelectedProfileResponse({ authority: facade, readProfile });
}
beforeEach(() => {
  current = selected();
  readSelection = vi.fn<(cookies: string | null) => Promise<PresentedBrowserSelection>>(async () => current);
  readProfile = vi.fn<typeof getProfileData>(async (_userId, _viewerUserId, options) =>
    options?.publicOnly ? { ...profile, email: undefined, credentials: [] } : profile,
  );
});

describe('selected profile response ownership', () => {
  it('re-admits actual central source and emits only its public owner beside the profile', async () => {
    const response = await fixture()('actual-captured-cookie', 'profile-owner');
    expect(response?.status).toBe(200);
    expect(await response?.json()).toEqual({
      browserProfileVersion: 1,
      owner: {
        userId: 'owner-a',
        authSessionId: 'login-a',
        generation: 3,
        cursor: { bindingId: 'a'.repeat(64), version: 2 },
      },
      profile,
    });
    expect(readSelection).toHaveBeenCalledTimes(2);
    expect(readProfile).toHaveBeenCalledWith('profile-owner', 'owner-a', { authToken: 'bsbd1_PRIVATE_SHORT_LEASE' });
    expect(response?.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response?.headers.getSetCookie()).toEqual([]);
  });
  it('delegates only genuine legacy mode without any reserved correlation material', async () => {
    expect(await fixture('legacy')('unrelated=value', 'profile-owner')).toBeNull();
    expect(readSelection).not.toHaveBeenCalled();
    expect(readProfile).not.toHaveBeenCalled();
  });
  it('returns an owner email only to the same actual admitted owner', async () => {
    readProfile.mockResolvedValue({ ...profile, id: 'owner-a', email: 'PRIVATE_EMAIL' });
    const response = await fixture()('actual-captured-cookie', 'owner-a');
    expect(response?.status).toBe(200);
    expect(await response?.json()).toMatchObject({ profile: { email: 'PRIVATE_EMAIL' } });
  });
  it('refuses a helper result that puts another profile email in the response', async () => {
    readProfile.mockResolvedValue({ ...profile, email: 'PRIVATE_FOREIGN_EMAIL' });
    const response = await fixture()('actual-captured-cookie', 'profile-owner');
    expect(response?.status).toBe(503);
    expect(await response?.text()).not.toContain('PRIVATE_');
  });
  it('keeps default public readiness disabled rather than accepting environment staging', async () => {
    expect((await fixture('backend-staging', false)(null, 'profile-owner'))?.status).toBe(503);
    expect(readSelection).not.toHaveBeenCalled();
    expect(readProfile).not.toHaveBeenCalled();
  });
  it.each(['missing-binding', 'proof-required', 'denied', 'unavailable', 'conflict'] as const)(
    'does not delegate %s to a legacy cookie or local profile lookup',
    async (status) => {
      readSelection.mockResolvedValue({ status });
      const response = await fixture()('actual-captured-cookie', 'profile-owner');
      expect(response?.status).toBe(status === 'unavailable' ? 503 : status === 'conflict' ? 409 : 401);
      expect(await response?.text()).not.toContain('PRIVATE_');
      expect(readProfile).not.toHaveBeenCalled();
    },
  );
  it('performs only an explicit public read after positive anonymous primary observation', async () => {
    readSelection.mockResolvedValue({ status: 'anonymous', cursor: current.cursor });
    const response = await fixture()('actual-anonymous-cookie', 'profile-owner');
    expect(response?.status).toBe(200);
    expect(await response?.json()).toEqual({
      browserProfileVersion: 1,
      owner: null,
      profile: { ...profile, email: undefined, credentials: [] },
    });
    expect(readProfile).toHaveBeenCalledWith('profile-owner', undefined, { authToken: undefined, publicOnly: true });
  });
  it('refuses helper-supplied private fields even after a positive anonymous observation', async () => {
    readSelection.mockResolvedValue({ status: 'anonymous', cursor: current.cursor });
    readProfile.mockResolvedValue({ ...profile, email: 'PRIVATE_EMAIL' });
    const response = await fixture()('actual-anonymous-cookie', 'profile-owner');
    expect(response?.status).toBe(503);
    expect(await response?.text()).not.toContain('PRIVATE_');
  });
  it('withholds a buffered private profile when the primary account switches during the read', async () => {
    const next = selected();
    readSelection.mockResolvedValueOnce(current).mockResolvedValueOnce({
      ...next,
      user: { ...next.user, id: 'owner-b' },
      session: { ...next.session, userId: 'owner-b' },
    });
    const response = await fixture()('actual-captured-cookie', 'profile-owner');
    expect(response?.status).toBe(409);
    expect(await response?.text()).not.toContain('PRIVATE_');
    expect(readProfile).toHaveBeenCalledTimes(1);
  });
  it.each(['denied', 'unavailable'] as const)('withholds all private bytes after late %s', async (status) => {
    readSelection.mockResolvedValueOnce(current).mockResolvedValueOnce({ status });
    const response = await fixture()('actual-captured-cookie', 'profile-owner');
    expect(response?.status).toBe(status === 'unavailable' ? 503 : 401);
    expect(await response?.text()).not.toContain('PRIVATE_');
  });
  it('preserves not-found only after final primary admission', async () => {
    readProfile.mockResolvedValue(null);
    const response = await fixture()('actual-captured-cookie', 'missing-profile');
    expect(response?.status).toBe(404);
    expect(readSelection).toHaveBeenCalledTimes(2);
  });
  it('bounds the buffered UTF8 response before publishing profile bytes', async () => {
    readProfile.mockResolvedValue({ ...profile, name: 'é'.repeat(40_000) });
    const response = await fixture()('actual-captured-cookie', 'profile-owner');
    expect(response?.status).toBe(503);
    expect(await response?.text()).not.toContain('PRIVATE_');
  });
});
