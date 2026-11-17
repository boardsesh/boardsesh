// @vitest-environment node
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CredentialAuthorityUnavailable } from '@/app/lib/auth/credential-admission.server';
import { CREDENTIAL_AUTHORITY_HEADER } from '@/app/lib/auth/credential-admission-response.server';

const control = vi.hoisted(() => ({ profile: vi.fn(), session: vi.fn() }));
vi.mock('server-only', () => ({}));
vi.mock('@/app/lib/auth/admitted-session.server', () => ({ getAdmittedServerSession: control.session }));
vi.mock('@/app/profile/[user_id]/server-profile-data', () => ({ getProfileData: control.profile }));
import { GET } from '../route';

const profile = {
  id: 'owner-a',
  email: 'owner@example.test',
  name: 'Climber',
  image: null,
  profile: null,
  credentials: [{ boardType: 'kilter', auroraUsername: 'kilter-owner' }],
  followerCount: 2,
  followingCount: 3,
  isFollowedByMe: false,
};
function read(userId = 'owner-a', expectedViewer?: string) {
  return GET(
    new NextRequest(`https://www.boardsesh.test/api/internal/profile/${userId}`, {
      headers: {
        cookie: 'next-auth.session-token=owner-a-cookie',
        ...(expectedViewer === undefined ? {} : { 'X-Boardsesh-Expected-Viewer': expectedViewer }),
      },
    }),
    { params: Promise.resolve({ userId }) },
  );
}
beforeEach(() => {
  vi.clearAllMocks();
  control.session.mockResolvedValue({ user: { id: 'owner-a' } });
  control.profile.mockResolvedValue(profile);
});

describe('profile route', () => {
  it('returns the flat profile read as the signed-in viewer', async () => {
    const response = await read();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(profile);
    expect(control.profile).toHaveBeenCalledWith('owner-a', 'owner-a');
    expect(response.headers.getSetCookie()).toEqual([]);
  });

  it('reads anonymously when nobody is signed in', async () => {
    control.session.mockResolvedValue(null);
    const response = await read();
    expect(response.status).toBe(200);
    expect(control.profile).toHaveBeenCalledWith('owner-a', undefined);
  });

  it('answers 404 for a missing profile', async () => {
    control.profile.mockResolvedValue(null);
    const response = await read('missing-user');
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'User not found' });
  });

  it('answers 503 without reading the profile when the credential authority is unavailable', async () => {
    control.session.mockRejectedValue(new CredentialAuthorityUnavailable());
    const response = await read();
    expect(response.status).toBe(503);
    expect(response.headers.get(CREDENTIAL_AUTHORITY_HEADER)).toBe('unavailable');
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(control.profile).not.toHaveBeenCalled();
  });

  it('answers 500 when the profile read fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    control.profile.mockRejectedValue(new Error('backend down'));
    const response = await read();
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Failed to get profile' });
  });

  describe('expected viewer', () => {
    beforeEach(() => {
      control.session.mockResolvedValue({ user: { id: 'owner-a' }, authSessionId: 'login-a' });
    });

    it('serves the tab that names the cookie’s account', async () => {
      const response = await read('climber-c', 'owner-a:login-a');
      expect(response.status).toBe(200);
      expect(control.profile).toHaveBeenCalledWith('climber-c', 'owner-a');
    });

    it.each([
      ['another account', 'owner-b:login-b'],
      ['a signed-out tab', 'anonymous'],
    ])('answers 409 without reading the profile when the tab shows %s', async (_label, expected) => {
      const response = await read('climber-c', expected);
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ code: 'viewer_changed', error: 'Reload this page.' });
      expect(response.headers.get('Cache-Control')).toBe('private, no-store');
      expect(control.profile).not.toHaveBeenCalled();
    });

    it('answers 409 when a signed-in tab meets a signed-out cookie', async () => {
      control.session.mockResolvedValue(null);
      const response = await read('climber-c', 'owner-a:login-a');
      expect(response.status).toBe(409);
      expect(control.profile).not.toHaveBeenCalled();
    });

    // The OpenAPI document lists this route for any caller, and an old tab sends no header.
    it('still answers a request that names no viewer', async () => {
      const response = await read('climber-c');
      expect(response.status).toBe(200);
      expect(control.profile).toHaveBeenCalledWith('climber-c', 'owner-a');
    });
  });
});
