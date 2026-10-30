/**
 * `requestBoardHandoff` (#7113): a crewmate asks the phone holding the board to
 * let go. Pinned here: who may ask (signed in, a board member, in the holder's
 * party session), the rate limit, what is published, and that `boardNowPlaying`
 * delivers the request to the holder alone.
 */

import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import type { BoardPresenceEvent, ConnectionContext } from '@boardsesh/shared-schema';

const state = vi.hoisted(() => ({
  gate: { isMember: true, firstSeenMs: null, lastReport: null, currentWriter: 'sam' as string | null },
  sessionId: 'session-1' as string | null,
  members: [{ userId: 'sam' }, { userId: 'liz' }] as Array<{ userId: string | null }>,
  profile: { name: 'Liz Account', image: null, displayName: 'Liz', avatarUrl: 'https://example.com/liz.jpg' } as {
    name: string | null;
    image: string | null;
    displayName: string | null;
    avatarUrl: string | null;
  } | null,
}));

vi.mock('../pubsub/index', () => ({
  pubsub: {
    getBoardReportGate: vi.fn(async () => state.gate),
    publishBoardPresenceEvent: vi.fn(),
  },
}));

vi.mock('../services/room-manager', () => ({
  roomManager: {
    getClient: vi.fn(() => (state.sessionId ? { sessionId: state.sessionId } : { sessionId: null })),
    getSessionUsers: vi.fn(async () => state.members),
  },
}));

vi.mock('../db/client', () => {
  const chain = {
    select: () => chain,
    from: () => chain,
    leftJoin: () => chain,
    where: () => chain,
    limit: async () => (state.profile ? [state.profile] : []),
  };
  return { db: chain };
});

vi.mock('../graphql/resolvers/shared/helpers', async () => {
  const actual = await vi.importActual<typeof import('../graphql/resolvers/shared/helpers')>(
    '../graphql/resolvers/shared/helpers',
  );
  return { ...actual, applyRateLimit: vi.fn().mockResolvedValue(undefined) };
});

const { boardHandoffMutations, BOARD_HANDOFF_RATE_LIMIT_PER_MINUTE, isForThisViewer } =
  await import('../graphql/resolvers/board-presence/handoff');
const { pubsub } = await import('../pubsub/index');
const { applyRateLimit } = await import('../graphql/resolvers/shared/helpers');

const publish = pubsub.publishBoardPresenceEvent as unknown as ReturnType<typeof vi.fn>;

function lizCtx(overrides: Partial<ConnectionContext> = {}): ConnectionContext {
  return {
    connectionId: 'conn-liz',
    transport: 'ws',
    isAuthenticated: true,
    userId: 'liz',
    ...overrides,
  } as ConnectionContext;
}

function request(ctx = lizCtx(), boardId = 42) {
  return boardHandoffMutations.requestBoardHandoff(undefined, { boardId }, ctx);
}

beforeEach(() => {
  vi.clearAllMocks();
  state.gate = { isMember: true, firstSeenMs: null, lastReport: null, currentWriter: 'sam' };
  state.sessionId = 'session-1';
  state.members = [{ userId: 'sam' }, { userId: 'liz' }];
  state.profile = { name: 'Liz Account', image: null, displayName: 'Liz', avatarUrl: 'https://example.com/liz.jpg' };
});

describe('requestBoardHandoff', () => {
  it('asks the holder by name, on the board channel, with no board seq', async () => {
    await expect(request()).resolves.toBe(true);
    expect(publish).toHaveBeenCalledTimes(1);
    const [boardKey, event] = publish.mock.calls[0] as [string, BoardPresenceEvent];
    expect(boardKey).toBe('42');
    expect(event).toMatchObject({
      __typename: 'BoardHandoffRequested',
      holderUserId: 'sam',
      requester: { userId: 'liz', displayName: 'Liz', avatarUrl: 'https://example.com/liz.jpg' },
    });
    expect(event).not.toHaveProperty('seq');
    if (event.__typename !== 'BoardHandoffRequested') throw new Error('wrong event');
    expect(event.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(Number.isNaN(Date.parse(event.requestedAt))).toBe(false);
  });

  it("falls back to the account's name and image without a profile", async () => {
    state.profile = { name: 'Liz Account', image: 'https://example.com/a.jpg', displayName: null, avatarUrl: null };
    await request();
    const [, event] = publish.mock.calls[0] as [string, BoardPresenceEvent];
    expect(event).toMatchObject({ requester: { displayName: 'Liz Account', avatarUrl: 'https://example.com/a.jpg' } });
  });

  it('is rate-limited per user', async () => {
    await request();
    expect(applyRateLimit).toHaveBeenCalledWith(
      expect.anything(),
      BOARD_HANDOFF_RATE_LIMIT_PER_MINUTE,
      'requestBoardHandoff',
    );
    (applyRateLimit as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('Rate limit exceeded'));
    await expect(request()).rejects.toThrow('Rate limit exceeded');
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it('requires sign-in', async () => {
    await expect(request(lizCtx({ isAuthenticated: false, userId: undefined }))).rejects.toThrow();
    expect(publish).not.toHaveBeenCalled();
  });

  it('requires board membership', async () => {
    state.gate = { ...state.gate, isMember: false };
    await expect(request()).rejects.toThrow('Not connected to this board');
    expect(publish).not.toHaveBeenCalled();
  });

  it('rejects a bad board id', async () => {
    await expect(request(lizCtx(), 0)).rejects.toThrow('boardId must be a positive integer');
  });

  it('answers false with nobody to ask: a free board, or the caller holds it', async () => {
    state.gate = { ...state.gate, currentWriter: null };
    await expect(request()).resolves.toBe(false);
    state.gate = { ...state.gate, currentWriter: 'liz' };
    await expect(request()).resolves.toBe(false);
    expect(publish).not.toHaveBeenCalled();
  });

  it('refuses outside a party session', async () => {
    state.sessionId = null;
    await expect(request()).rejects.toThrow('Join the session to take the board');
    expect(publish).not.toHaveBeenCalled();
  });

  it("refuses when the holder isn't in the caller's session", async () => {
    state.members = [{ userId: 'liz' }, { userId: 'someone-else' }];
    await expect(request()).rejects.toThrow('The board is held outside your session');
    expect(publish).not.toHaveBeenCalled();
  });

  it('refuses an anonymous holder, which no session roster can name', async () => {
    state.gate = { ...state.gate, currentWriter: 'conn:abc' };
    state.members = [{ userId: 'liz' }, { userId: null }];
    await expect(request()).rejects.toThrow('The board is held outside your session');
    expect(publish).not.toHaveBeenCalled();
  });
});

describe('boardNowPlaying delivery of a hand-off request', () => {
  const handoff: BoardPresenceEvent = {
    __typename: 'BoardHandoffRequested',
    holderUserId: 'sam',
    requester: { userId: 'liz', displayName: 'Liz', avatarUrl: null },
    requestId: 'request-1',
    requestedAt: '2026-10-30T12:00:00.000Z',
  };

  it('reaches only the holder it names', () => {
    expect(isForThisViewer(handoff, 'sam')).toBe(true);
    expect(isForThisViewer(handoff, 'liz')).toBe(false);
    expect(isForThisViewer(handoff, null)).toBe(false);
    expect(isForThisViewer(handoff, undefined)).toBe(false);
  });

  it('leaves every other event alone', () => {
    const freed: BoardPresenceEvent = { __typename: 'BoardConnectionChanged', holder: null, seq: 9 };
    expect(isForThisViewer(freed, null)).toBe(true);
    expect(isForThisViewer(freed, 'liz')).toBe(true);
  });
});
