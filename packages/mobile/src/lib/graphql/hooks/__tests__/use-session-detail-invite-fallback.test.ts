// The join screen's dormant-session fallback (#6004).
//
// `session` returns null for any empty roster, so an invite opened while the
// host's phone was asleep read as "Session not found" for a session that was
// still running. With `inviteFallback` a null answer is followed by
// `sessionInvitePreview`, which reads the durable row.
//
// Imports the hook file directly, not the `hooks` barrel (the barrel reaches
// react-native's Flow source). Mocks only the GraphQL client.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionInvitePreview } from '@boardsesh/shared-schema';
import { GET_SESSION_INVITE_PREVIEW } from '@boardsesh/graphql/operations';

const requestMock = vi.fn();
vi.mock('../../client', () => ({
  getHttpClient: () => ({ request: requestMock }),
}));

import { fetchSessionPreview, sessionPreviewFromInvite } from '../use-session-detail';
import { GET_SESSION } from '../../operations';

const SESSION_ID = 'session-42';

function invite(overrides: Partial<SessionInvitePreview> = {}): SessionInvitePreview {
  return {
    sessionId: SESSION_ID,
    state: 'dormant',
    hostName: 'Alex',
    boardName: 'Hangar Kilter',
    boardPath: 'kilter/1/10/1,20/40',
    gymName: null,
    ...overrides,
  };
}

const liveSession = {
  id: SESSION_ID,
  name: null,
  boardPath: 'kilter/1/10/1,20/40',
  color: null,
  goal: null,
  isPublic: true,
  startedAt: null,
  endedAt: null,
  users: [{ id: 'u1', username: 'Alex', isLeader: true }],
};

beforeEach(() => {
  requestMock.mockReset();
});

describe('sessionPreviewFromInvite', () => {
  it('turns a dormant invite into a joinable preview with an empty roster', () => {
    expect(sessionPreviewFromInvite(invite())).toEqual({
      id: SESSION_ID,
      name: null,
      boardPath: 'kilter/1/10/1,20/40',
      color: null,
      goal: null,
      isPublic: false,
      startedAt: null,
      endedAt: null,
      users: [],
      invite: { state: 'dormant', hostName: 'Alex' },
    });
  });

  it('marks an ended invite as ended, with no board path to join on', () => {
    const preview = sessionPreviewFromInvite(invite({ state: 'ended', hostName: null, boardPath: null }));

    expect(preview?.invite).toEqual({ state: 'ended', hostName: null });
    expect(preview?.boardPath).toBe('');
  });

  it('is null for a missing session', () => {
    expect(sessionPreviewFromInvite(invite({ state: 'not_found', boardPath: null }))).toBeNull();
  });

  it('is null for a live invite: a live session answers through `session`, with its roster', () => {
    expect(sessionPreviewFromInvite(invite({ state: 'live' }))).toBeNull();
  });

  it('is null for a dormant session with no board path, which cannot be joined', () => {
    expect(sessionPreviewFromInvite(invite({ boardPath: null }))).toBeNull();
  });
});

describe('fetchSessionPreview', () => {
  it('returns the live session and never asks for the invite preview', async () => {
    requestMock.mockResolvedValueOnce({ session: liveSession });

    expect(await fetchSessionPreview(SESSION_ID, true)).toEqual(liveSession);
    expect(requestMock).toHaveBeenCalledTimes(1);
    expect(requestMock).toHaveBeenCalledWith(GET_SESSION, { sessionId: SESSION_ID });
  });

  it('shows a dormant session as joinable instead of not found', async () => {
    requestMock.mockResolvedValueOnce({ session: null }).mockResolvedValueOnce({ sessionInvitePreview: invite() });

    const preview = await fetchSessionPreview(SESSION_ID, true);

    expect(preview?.id).toBe(SESSION_ID);
    expect(preview?.boardPath).toBe('kilter/1/10/1,20/40');
    expect(preview?.invite).toEqual({ state: 'dormant', hostName: 'Alex' });
    expect(requestMock).toHaveBeenNthCalledWith(2, GET_SESSION_INVITE_PREVIEW, { sessionId: SESSION_ID });
  });

  it('reports an ended session as ended instead of not found', async () => {
    requestMock
      .mockResolvedValueOnce({ session: null })
      .mockResolvedValueOnce({ sessionInvitePreview: invite({ state: 'ended', hostName: null, boardPath: null }) });

    expect((await fetchSessionPreview(SESSION_ID, true))?.invite?.state).toBe('ended');
  });

  it('stays null for a session that does not exist', async () => {
    requestMock
      .mockResolvedValueOnce({ session: null })
      .mockResolvedValueOnce({ sessionInvitePreview: invite({ state: 'not_found', boardPath: null }) });

    expect(await fetchSessionPreview(SESSION_ID, true)).toBeNull();
  });

  it('stays null, as before, when the backend does not know the invite query yet', async () => {
    requestMock
      .mockResolvedValueOnce({ session: null })
      .mockRejectedValueOnce(new Error('Cannot query field "sessionInvitePreview" on type "Query".'));

    expect(await fetchSessionPreview(SESSION_ID, true)).toBeNull();
  });

  it('still throws when the session query itself fails, so the screen can offer a retry', async () => {
    requestMock.mockRejectedValueOnce(new Error('Network request failed'));

    await expect(fetchSessionPreview(SESSION_ID, true)).rejects.toThrow('Network request failed');
  });

  it('does not fall back for the in-session readers of the hook', async () => {
    requestMock.mockResolvedValueOnce({ session: null });

    expect(await fetchSessionPreview(SESSION_ID, false)).toBeNull();
    expect(requestMock).toHaveBeenCalledTimes(1);
  });
});
