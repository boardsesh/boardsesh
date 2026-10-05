import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import type { SessionInvitePreview } from '@boardsesh/shared-schema';

vi.mock('server-only', () => ({}));

const executeAuthenticatedGraphQL = vi.hoisted(() => vi.fn());
vi.mock('@/app/lib/graphql/server-graphql', () => ({ executeAuthenticatedGraphQL }));

const { fetchSessionInvite, inviteBoardAngle, inviteBoardLabel, sessionInviteFromPreview } =
  await import('../session-invite');

const SESSION_ID = '550e8400-e29b-41d4-a716-446655440000';

function preview(overrides: Partial<SessionInvitePreview> = {}): SessionInvitePreview {
  return {
    sessionId: SESSION_ID,
    state: 'live',
    hostName: 'Alex',
    boardName: 'Hangar Kilter',
    boardPath: 'kilter/1/10/1,20/40',
    gymName: 'The Climbing Hangar',
    ...overrides,
  };
}

beforeEach(() => {
  executeAuthenticatedGraphQL.mockReset();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('inviteBoardLabel', () => {
  it("uses the board's own name when the backend released it", () => {
    expect(inviteBoardLabel({ boardName: 'Hangar Kilter', boardPath: 'kilter/1/10/1,20/40' })).toBe('Hangar Kilter');
  });

  it('falls back to the board type from a config path', () => {
    expect(inviteBoardLabel({ boardName: null, boardPath: 'kilter/1/10/1,20/40' })).toBe('Kilter');
    expect(inviteBoardLabel({ boardName: null, boardPath: '/moonboard/2/1/1,2/40' })).toBe('MoonBoard');
  });

  it('says nothing for a named-board path whose name was withheld', () => {
    // The slug is derived from the name the backend just declined to give.
    expect(inviteBoardLabel({ boardName: null, boardPath: '/b/secret-garage-wall-c937dad5/40' })).toBeNull();
  });

  it('says nothing without a path', () => {
    expect(inviteBoardLabel({ boardName: null, boardPath: null })).toBeNull();
  });
});

describe('inviteBoardAngle', () => {
  it('reads the angle from either path shape', () => {
    expect(inviteBoardAngle('kilter/1/10/1,20/40')).toBe(40);
    expect(inviteBoardAngle('/b/boiler-room-moonboard-c937dad5/25/list')).toBe(25);
  });

  it('is null when the path carries no angle, or there is no path', () => {
    expect(inviteBoardAngle('/b/boiler-room-moonboard-c937dad5')).toBeNull();
    expect(inviteBoardAngle('kilter/1/10/1,20')).toBeNull();
    expect(inviteBoardAngle(null)).toBeNull();
  });
});

describe('sessionInviteFromPreview', () => {
  it('carries host, board, angle and gym for a live session', () => {
    expect(sessionInviteFromPreview(preview())).toEqual({
      state: 'live',
      hostName: 'Alex',
      boardLabel: 'Hangar Kilter',
      boardAngle: 40,
      gymName: 'The Climbing Hangar',
    });
  });

  it('keeps a dormant session joinable, with its details', () => {
    const invite = sessionInviteFromPreview(preview({ state: 'dormant' }));

    expect(invite.state).toBe('dormant');
    expect(invite.hostName).toBe('Alex');
  });

  it('handles a session with no board name and no gym', () => {
    expect(sessionInviteFromPreview(preview({ boardName: null, gymName: null, hostName: null }))).toEqual({
      state: 'live',
      hostName: null,
      boardLabel: 'Kilter',
      boardAngle: 40,
      gymName: null,
    });
  });

  it.each(['ended', 'not_found'] as const)('drops every detail for a %s session, whatever came back', (state) => {
    expect(sessionInviteFromPreview(preview({ state }))).toEqual({
      state,
      hostName: null,
      boardLabel: null,
      boardAngle: null,
      gymName: null,
    });
  });
});

describe('fetchSessionInvite', () => {
  it('asks the backend for the invite preview by session id', async () => {
    executeAuthenticatedGraphQL.mockResolvedValue({ sessionInvitePreview: preview() });

    const invite = await fetchSessionInvite(SESSION_ID);

    expect(invite.state).toBe('live');
    expect(executeAuthenticatedGraphQL).toHaveBeenCalledTimes(1);
    expect(executeAuthenticatedGraphQL.mock.calls[0][1]).toEqual({ sessionId: SESSION_ID });
    // No auth token: the page is for someone with no account.
    expect(executeAuthenticatedGraphQL.mock.calls[0][2]).toBeUndefined();
  });

  it('answers not_found for a malformed id without a round trip', async () => {
    for (const badId of ['bad id!', '', '../etc/passwd', 'a'.repeat(101)]) {
      expect((await fetchSessionInvite(badId)).state).toBe('not_found');
    }
    expect(executeAuthenticatedGraphQL).not.toHaveBeenCalled();
  });

  it('reports unavailable, never not_found, when the backend does not answer', async () => {
    executeAuthenticatedGraphQL.mockRejectedValue(new Error('Rate limit exceeded'));

    expect(await fetchSessionInvite(SESSION_ID)).toEqual({
      state: 'unavailable',
      hostName: null,
      boardLabel: null,
      boardAngle: null,
      gymName: null,
    });
  });
});
