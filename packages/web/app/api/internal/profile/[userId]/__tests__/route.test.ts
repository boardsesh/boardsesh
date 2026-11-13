// @vitest-environment node
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdmittedBrowserSelection } from '@/app/lib/auth/presented-browser-selection.server';
const control = vi.hoisted(() => ({ observe: vi.fn(), lease: vi.fn(), profile: vi.fn(), legacy: vi.fn() }));
vi.mock('server-only', () => ({}));
vi.mock('@/app/lib/auth/admitted-session.server', () => ({ getAdmittedServerSession: control.legacy }));
vi.mock('@/app/profile/[user_id]/server-profile-data', () => ({ getProfileData: control.profile }));
vi.mock('@/app/lib/auth/browser-consumers.server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/app/lib/auth/browser-consumers.server')>();
  return {
    ...actual,
    browserConsumerFacade: { ...actual.browserConsumerFacade, observe: control.observe, lease: control.lease },
  };
});
import { GET } from '../route';

function selected(): AdmittedBrowserSelection {
  return {
    status: 'admitted',
    bindingToken: 'A'.repeat(43),
    actor: { version: 2, credential: { kind: 'canonical-token', token: 'PRIVATE_ACTUAL_SOURCE' } },
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
    user: { id: 'owner-a', name: 'Climber', email: 'PRIVATE_EMAIL', image: null },
  };
}
const profile = {
  id: 'owner-a',
  email: 'PRIVATE_EMAIL',
  name: 'Climber',
  image: null,
  profile: null,
  credentials: [{ boardType: 'kilter', auroraUsername: 'PRIVATE_MAPPING' }],
  followerCount: 2,
  followingCount: 3,
  isFollowedByMe: false,
};
const cookie = '__Host-boardsesh.browser-binding=' + 'A'.repeat(43) + '; next-auth.session-token=unrelated-old-B';
function read() {
  return GET(new NextRequest('https://www.boardsesh.test/api/internal/profile/owner-a', { headers: { cookie } }), {
    params: Promise.resolve({ userId: 'owner-a' }),
  });
}
beforeEach(() => {
  vi.clearAllMocks();
  control.observe.mockResolvedValue(selected());
  control.lease.mockResolvedValue({
    status: 'admitted',
    token: 'bsbd1_OWNED',
    usableForMs: 60_000,
    owner: {
      userId: 'owner-a',
      authSessionId: 'login-a',
      generation: 3,
      cursor: { bindingId: 'a'.repeat(64), version: 2 },
    },
  });
  control.profile.mockResolvedValue(profile);
  control.legacy.mockRejectedValue(new Error('Selected requests must not load a legacy viewer'));
});

describe('actual profile route selected response seam', () => {
  it('uses the real response adapter, captured cookie and exact backend lease without a legacy viewer', async () => {
    const response = await read();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ browserProfileVersion: 1, owner: { userId: 'owner-a' }, profile });
    expect(control.observe).toHaveBeenCalledTimes(2);
    expect(control.observe).toHaveBeenNthCalledWith(1, cookie);
    expect(control.observe).toHaveBeenNthCalledWith(2, cookie);
    expect(control.profile).toHaveBeenCalledWith('owner-a', 'owner-a', { authToken: 'bsbd1_OWNED' });
    expect(control.legacy).not.toHaveBeenCalled();
    expect(response.headers.getSetCookie()).toEqual([]);
  });
  it('withholds all private bytes when the actual route sees primary drift before publication', async () => {
    const next = selected();
    control.observe.mockResolvedValueOnce(selected()).mockResolvedValueOnce({
      ...next,
      session: { ...next.session, authSessionId: 'later-login' },
    });
    const response = await read();
    expect(response.status).toBe(409);
    expect(await response.text()).not.toContain('PRIVATE_');
    expect(control.legacy).not.toHaveBeenCalled();
  });
  it('never turns lease uncertainty into an implicit local or legacy profile read', async () => {
    control.lease.mockResolvedValue({ status: 'unavailable' });
    const response = await read();
    expect(response.status).toBe(503);
    expect(control.profile).not.toHaveBeenCalled();
    expect(control.legacy).not.toHaveBeenCalled();
  });
  it('retains the existing flat response and session lookup only for genuine legacy selection', async () => {
    control.observe.mockResolvedValue({ status: 'legacy' });
    control.legacy.mockResolvedValue({ user: { id: 'owner-a' } });
    const response = await read();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(profile);
    expect(control.profile).toHaveBeenCalledWith('owner-a', 'owner-a');
    expect(control.lease).not.toHaveBeenCalled();
  });
});
