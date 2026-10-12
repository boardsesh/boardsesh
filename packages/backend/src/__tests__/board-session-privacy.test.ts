import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import type { BoardPresenceClimb, BoardPresenceStats, SessionUser } from '@boardsesh/shared-schema';

vi.hoisted(() => vi.resetModules());

type BoardRow = { userIds: readonly string[]; onBoard: { boardId: number | null } };
const privacy = vi.hoisted(() => ({
  anonymousOnBoardUserIds: vi.fn(),
  anonymousOnBoardUserIdsByBoard: vi.fn(),
  canViewActivityIdentity: vi.fn(),
  canViewContent: vi.fn(),
  visibleActivityUserIds: vi.fn(),
  visibleActivityUserIdsByBoard: vi.fn(),
}));
/** The board every session resolves to; null leaves it unplaced. */
const sessionBoard = vi.hoisted(() => ({ boardId: 12 as number | null, resolve: vi.fn() }));
type ClimbRow = { uuid: string; userId: string | null; isListed: boolean; isDraft: boolean };
const readable = vi.hoisted(() => ({
  climbs: [] as ClimbRow[],
  /**
   * What the next single-row lookup finds when it differs from what the
   * readability predicate keeps: the hardest-send catalog lookup sees a row
   * that the predicate then drops. Consumed by that one lookup.
   */
  nextLookup: null as ClimbRow[] | null,
}));
vi.mock('../services/privacy', () => privacy);
vi.mock('../services/session-board', () => ({
  resolveSessionBoards: sessionBoard.resolve,
  parseSessionBoardPath: () => ({ slug: null, config: null, boardType: null, angle: null }),
}));
vi.mock('../db/client', async () => {
  const { boardSessions } = await import('@boardsesh/db/schema');
  return {
    db: {
      select: () => ({
        from: (table: unknown) => ({
          where: () => {
            // A live session's own row, for the board resolution; climb rows otherwise.
            const rows =
              table === boardSessions
                ? [{ id: 'session-1', boardId: null, boardPath: 'kilter/1/10/1/40', createdByUserId: null }]
                : readable.climbs;
            return Object.assign(Promise.resolve(rows), {
              limit: async (count?: number) => {
                if (table === boardSessions) return rows;
                const lookup = readable.nextLookup ?? rows;
                readable.nextLookup = null;
                return lookup.slice(0, count);
              },
            });
          },
        }),
      }),
    },
  };
});

const { boardSessionPrivacyResolvers } = await import('../graphql/resolvers/shared/board-session-privacy');
const {
  redactBoardClimbs,
  redactBoardHolder,
  redactBoardIdentity,
  redactBoardStats,
  redactQueueItem,
  redactSessionUsers,
  sessionParticipantId,
  sessionEventParticipantId,
  sessionVisibleUserIds,
} = await import('../services/board-session-privacy');

const BOARD_ID = 9;

const display: BoardPresenceClimb = {
  climbUuid: 'climb-1',
  name: 'A climb',
  sentByUserId: 'climber-1',
  sentByDisplayName: 'Private climber',
  sentByAvatarUrl: 'https://example.test/private-avatar',
  sentAt: '2026-10-08T12:00:00Z',
  seq: 7,
  identityPolicyVersion: 1,
  sessionId: 'session-1',
};

beforeEach(() => {
  vi.stubEnv('NEXTAUTH_SECRET', 'privacy-unit-test-secret');
  vi.clearAllMocks();
  privacy.canViewActivityIdentity.mockResolvedValue(false);
  privacy.visibleActivityUserIds.mockResolvedValue(new Set());
  privacy.anonymousOnBoardUserIds.mockResolvedValue(new Set());
  // Nobody on a session board is named unless a test says so.
  privacy.visibleActivityUserIdsByBoard.mockImplementation(async (rows: readonly BoardRow[]) =>
    rows.map(() => new Set<string>()),
  );
  sessionBoard.boardId = 12;
  sessionBoard.resolve.mockImplementation(
    async (sessions: readonly { id: string }[]) =>
      new Map(sessionBoard.boardId === null ? [] : sessions.map((session) => [session.id, sessionBoard.boardId])),
  );
  readable.climbs = [{ uuid: display.climbUuid, userId: null, isListed: true, isDraft: false }];
  readable.nextLookup = null;
  privacy.canViewContent.mockResolvedValue(true);
});
afterEach(() => vi.unstubAllEnvs());

describe('board history identity', () => {
  it('keeps the climb, time and order while concealing attribution from a stranger', async () => {
    const [hidden] = await redactBoardClimbs([display], 'stranger', BOARD_ID);
    expect(hidden).toMatchObject({
      climbUuid: display.climbUuid,
      name: display.name,
      seq: 7,
      sentAt: display.sentAt,
      sentByUserId: null,
      sentByDisplayName: null,
      sentByAvatarUrl: null,
    });
    // The sender's account decides, on this board; the session the send was in is not consulted.
    expect(privacy.visibleActivityUserIds).toHaveBeenCalledWith(['climber-1'], 'stranger', { boardId: BOARD_ID });
  });
  it('checks every sender on a page in one lookup', async () => {
    privacy.visibleActivityUserIds.mockResolvedValue(new Set(['climber-1']));
    const page = [display, { ...display, seq: 8, sentByUserId: 'climber-2' }, { ...display, seq: 9 }];
    const redacted = await redactBoardClimbs(page, 'viewer', BOARD_ID);
    expect(redacted.map((climb) => climb.sentByUserId)).toEqual(['climber-1', null, 'climber-1']);
    expect(privacy.visibleActivityUserIds).toHaveBeenCalledTimes(1);
    expect(privacy.canViewActivityIdentity).not.toHaveBeenCalled();
  });
  it('rechecks an existing cached display after a follower is revoked', async () => {
    privacy.visibleActivityUserIds.mockResolvedValueOnce(new Set(['climber-1'])).mockResolvedValueOnce(new Set());
    expect((await redactBoardClimbs([display], 'follower', BOARD_ID))[0].sentByUserId).toBe('climber-1');
    expect((await redactBoardClimbs([display], 'follower', BOARD_ID))[0].sentByUserId).toBeNull();
    expect(display.sentByUserId).toBe('climber-1');
  });
  it('names a historical row with no session or policy version by its climber account alone', async () => {
    const historical = { ...display, sessionId: null, identityPolicyVersion: undefined };
    privacy.visibleActivityUserIds.mockResolvedValue(new Set(['climber-1']));
    expect((await redactBoardClimbs([historical], 'stranger', BOARD_ID))[0].sentByUserId).toBe('climber-1');
    privacy.visibleActivityUserIds.mockResolvedValue(new Set());
    expect((await redactBoardClimbs([historical], 'stranger', BOARD_ID))[0].sentByUserId).toBeNull();
    expect(privacy.visibleActivityUserIds).toHaveBeenLastCalledWith(['climber-1'], 'stranger', { boardId: BOARD_ID });
  });
  it('retains chronology but removes private climb content', async () => {
    // The primary SQL policy excludes the inaccessible authored source row.
    readable.climbs = [];
    const [hidden] = await redactBoardClimbs(
      [{ ...display, frames: 'private-holds', setter: 'Secret setter' }],
      'viewer',
      BOARD_ID,
    );
    expect(hidden).toMatchObject({ seq: 7, sentAt: display.sentAt, name: null, frames: null, setter: null });
    expect(hidden.climbUuid).toBe(display.climbUuid);
  });
  it('checks the hardest send item audience as well as account privacy', async () => {
    const stats: BoardPresenceStats = {
      climbsSentCount: 20,
      distinctClimbersCount: 4,
      hardestGrade: 'V8',
      hardestSend: {
        climbUuid: 'climb-1',
        grade: 'V8',
        sentByUserId: 'climber-1',
        tickUuid: 'private-tick',
        sessionId: 'session-1',
        sentAt: display.sentAt,
      },
    };
    await redactBoardStats(stats, 'viewer', BOARD_ID);
    expect(privacy.canViewActivityIdentity).toHaveBeenCalledWith('climber-1', 'viewer', {
      entityType: 'tick',
      entityId: 'private-tick',
    });
  });
  it('keeps every aggregate when the hardest sender is private', async () => {
    const stats: BoardPresenceStats = {
      climbsSentCount: 20,
      distinctClimbersCount: 4,
      hardestGrade: 'V8',
      hardestSend: {
        climbUuid: 'climb-1',
        grade: 'V8',
        sentByUserId: 'climber-1',
        sentByDisplayName: 'Private climber',
        sentAt: display.sentAt,
      },
    };
    const hidden = await redactBoardStats(stats, 'viewer', BOARD_ID);
    expect(hidden).toMatchObject({
      climbsSentCount: 20,
      distinctClimbersCount: 4,
      hardestGrade: 'V8',
      hardestSend: { climbUuid: 'climb-1', grade: 'V8', sentByUserId: null, sentByDisplayName: null },
    });
  });
  it('does not name a draft as the hardest send to anyone but its owner, and keeps every aggregate', async () => {
    const stats: BoardPresenceStats = {
      climbsSentCount: 20,
      distinctClimbersCount: 4,
      hardestGrade: 'V8',
      hardestSend: {
        climbUuid: 'climb-1',
        grade: 'V8',
        climbOwnerId: 'setter',
        sentByUserId: null,
        sentAt: display.sentAt,
      },
    };
    // The catalog has the draft; the primary SQL predicate drops it for anyone
    // but its owner. The real-DB matrix verifies that predicate.
    const draftRow = { uuid: 'climb-1', userId: 'setter', isListed: false, isDraft: true };
    readable.climbs = [];
    readable.nextLookup = [draftRow];
    expect(await redactBoardStats(stats, 'viewer', BOARD_ID)).toEqual({ ...stats, hardestSend: null });
    readable.nextLookup = [draftRow];
    expect(await redactBoardStats(stats, null, BOARD_ID)).toEqual({ ...stats, hardestSend: null });
    readable.climbs = [draftRow];
    expect((await redactBoardStats(stats, 'setter', BOARD_ID)).hardestSend?.climbUuid).toBe('climb-1');

    // A draft nobody owns is nobody's, an anonymous viewer included.
    readable.climbs = [];
    readable.nextLookup = [{ ...draftRow, userId: null }];
    expect(
      await redactBoardStats({ ...stats, hardestSend: { ...stats.hardestSend!, climbOwnerId: null } }, null, BOARD_ID),
    ).toMatchObject({ climbsSentCount: 20, distinctClimbersCount: 4, hardestGrade: 'V8', hardestSend: null });

    // A climb missing from the catalog keeps its grade under no name.
    readable.climbs = [];
    expect(await redactBoardStats(stats, 'viewer', BOARD_ID)).toMatchObject({
      hardestSend: { climbUuid: 'climb-1', grade: 'V8', name: null },
    });
  });
  it("names a published climb as the hardest send whoever set it, a deleted author's included", async () => {
    const stats: BoardPresenceStats = {
      climbsSentCount: 20,
      distinctClimbersCount: 4,
      hardestGrade: 'V8',
      hardestSend: {
        climbUuid: 'climb-1',
        grade: 'V8',
        climbOwnerId: null,
        sentByUserId: null,
        sentAt: display.sentAt,
      },
    };
    readable.climbs = [{ uuid: 'climb-1', userId: null, isListed: true, isDraft: false }];
    expect((await redactBoardStats(stats, 'viewer', BOARD_ID)).hardestSend?.climbUuid).toBe('climb-1');
    expect((await redactBoardStats(stats, null, BOARD_ID)).hardestSend?.climbUuid).toBe('climb-1');
    // No climb audience is consulted.
    expect(privacy.canViewContent).not.toHaveBeenCalled();
  });
});

describe('Bluetooth holder identity', () => {
  const holder = { userId: 'climber-1', displayName: 'Public climber', avatarUrl: 'https://example.test/a' };
  it('names the holder by their account privacy with no live session on the board', async () => {
    privacy.visibleActivityUserIds.mockResolvedValue(new Set(['climber-1']));
    expect(await redactBoardHolder(holder, 'stranger', BOARD_ID)).toEqual(holder);
    expect(privacy.visibleActivityUserIds).toHaveBeenCalledWith(['climber-1'], 'stranger', { boardId: BOARD_ID });
  });
  it('names the holder to themselves without a lookup', async () => {
    expect(await redactBoardHolder(holder, 'climber-1', BOARD_ID)).toEqual(holder);
    expect(privacy.visibleActivityUserIds).not.toHaveBeenCalled();
  });
  it('withholds a private holder from a viewer their account does not allow', async () => {
    expect(await redactBoardHolder(holder, 'stranger', BOARD_ID)).toEqual({
      userId: null,
      displayName: null,
      avatarUrl: null,
    });
  });
});

describe('board identity on an item', () => {
  const item = {
    uuid: 'tick-1',
    boardId: 9,
    boardDisplayName: 'Garage wall',
    locationName: 'Somewhere',
    gymName: 'Gym',
    latitude: 1,
    longitude: 2,
  };
  it('keeps the row and blanks only the board fields when the board is hidden', () => {
    expect(redactBoardIdentity(item, false)).toEqual({
      uuid: 'tick-1',
      boardId: null,
      boardDisplayName: null,
      locationName: null,
      gymName: null,
      latitude: null,
      longitude: null,
    });
  });
  it('returns the item untouched when the board may be named', () => {
    expect(redactBoardIdentity(item, true)).toBe(item);
  });
});

describe('session roster identity', () => {
  const user: SessionUser = {
    id: 'climber-1',
    userId: 'climber-1',
    username: 'Private climber',
    avatarUrl: 'https://example.test/avatar',
    isLeader: true,
    connectionState: 'CONNECTED',
  };
  it('does not treat session participation as permission to identify somebody', async () => {
    const [hidden] = await redactSessionUsers([user], 'fellow-participant', 'session-1');
    expect(hidden).toMatchObject({ userId: null, username: '', avatarUrl: undefined, isLeader: true });
    expect(hidden.id).not.toBe(user.userId);
  });
  it('keeps protocol identity stable on reconnect but unlinks different sessions', () => {
    expect(sessionParticipantId('session-1', 'climber-1')).toBe(sessionParticipantId('session-1', 'climber-1'));
    expect(sessionParticipantId('session-1', 'climber-1')).not.toBe(sessionParticipantId('session-2', 'climber-1'));
  });
  it('lets explicitly approved viewers see names without exposing the account ID as a protocol ID', async () => {
    privacy.visibleActivityUserIdsByBoard.mockImplementation(async (rows: readonly BoardRow[]) =>
      rows.map((row) => new Set(row.userIds)),
    );
    const [visible] = await redactSessionUsers([user], 'approved-follower', 'session-1');
    expect(visible.userId).toBe(user.userId);
    expect(visible.username).toBe(user.username);
    expect(visible.id).not.toBe(user.userId);
  });
});

describe('anonymous on boards they do not own', () => {
  const rosterUser: SessionUser = {
    id: 'climber-1',
    userId: 'climber-1',
    username: 'Public climber',
    avatarUrl: 'https://example.test/avatar',
    isLeader: false,
    connectionState: 'CONNECTED',
  };
  beforeEach(() => {
    // Public accounts the viewer could otherwise name; climber-1 stays anonymous
    // on the board, so a lookup scoped to it leaves them out.
    privacy.canViewActivityIdentity.mockResolvedValue(true);
    privacy.visibleActivityUserIds.mockImplementation(
      async (userIds: readonly (string | null | undefined)[], _viewerId: unknown, onBoard?: unknown) =>
        new Set(userIds.filter((userId): userId is string => !!userId && !(onBoard && userId === 'climber-1'))),
    );
    privacy.anonymousOnBoardUserIds.mockResolvedValue(new Set(['climber-1']));
    privacy.visibleActivityUserIdsByBoard.mockImplementation(async (rows: readonly BoardRow[]) =>
      rows.map((row) => new Set(row.userIds.filter((userId) => userId !== 'climber-1'))),
    );
  });

  it('keeps the wall feed row and its order but drops the name, asking about this board', async () => {
    const [row] = await redactBoardClimbs([display], 'stranger', BOARD_ID);
    expect(row).toMatchObject({
      climbUuid: display.climbUuid,
      name: display.name,
      seq: 7,
      sentAt: display.sentAt,
      sentByUserId: null,
      sentByDisplayName: null,
      sentByAvatarUrl: null,
    });
    expect(privacy.visibleActivityUserIds).toHaveBeenCalledWith(['climber-1'], 'stranger', { boardId: BOARD_ID });
  });
  it('names the sender again once the predicate no longer holds', async () => {
    privacy.visibleActivityUserIds.mockResolvedValue(new Set(['climber-1']));
    expect((await redactBoardClimbs([display], 'stranger', BOARD_ID))[0].sentByUserId).toBe('climber-1');
  });
  it('unnames the hardest send but keeps every total', async () => {
    const stats: BoardPresenceStats = {
      climbsSentCount: 20,
      distinctClimbersCount: 4,
      hardestGrade: 'V8',
      hardestSend: {
        climbUuid: 'climb-1',
        grade: 'V8',
        sentByUserId: 'climber-1',
        sentByDisplayName: 'Public climber',
        tickUuid: 'tick-1',
        sentAt: display.sentAt,
      },
    };
    expect(await redactBoardStats(stats, 'stranger', BOARD_ID)).toMatchObject({
      climbsSentCount: 20,
      distinctClimbersCount: 4,
      hardestGrade: 'V8',
      hardestSend: { climbUuid: 'climb-1', grade: 'V8', sentByUserId: null, sentByDisplayName: null },
    });
  });
  it('unnames the Bluetooth holder on that board', async () => {
    const holder = { userId: 'climber-1', displayName: 'Public climber', avatarUrl: 'https://example.test/a' };
    expect(await redactBoardHolder(holder, 'stranger', BOARD_ID)).toEqual({
      userId: null,
      displayName: null,
      avatarUrl: null,
    });
  });
  it('keeps the opaque session id in the roster of a session on that board, judged on the board it is on', async () => {
    const [hidden] = await redactSessionUsers([rosterUser], 'stranger', 'session-1');
    expect(hidden).toMatchObject({ userId: null, username: '', avatarUrl: undefined });
    expect(hidden.id).toBe(sessionParticipantId('session-1', 'climber-1'));
    expect(sessionBoard.resolve).toHaveBeenCalledWith([expect.objectContaining({ id: 'session-1' })]);
    expect(privacy.visibleActivityUserIdsByBoard).toHaveBeenCalledWith(
      [{ rowIndex: 0, userIds: ['climber-1'], onBoard: { boardId: 12, sessionId: 'session-1' } }],
      'stranger',
    );
  });
  it('fails closed when nothing places the session on a board', async () => {
    sessionBoard.boardId = null;
    await redactSessionUsers([rosterUser], 'stranger', 'session-1');
    // No board of the climber's has the session's config, so no known board.
    expect(privacy.visibleActivityUserIdsByBoard).toHaveBeenCalledWith(
      [{ rowIndex: 0, userIds: ['climber-1'], onBoard: { boardId: null, sessionId: 'session-1' } }],
      'stranger',
    );
  });
  it('drops added-by and ticked-by on a queue item in a session on that board', async () => {
    const item = {
      uuid: 'queue-1',
      climb: { uuid: display.climbUuid, name: 'A climb' },
      addedBy: 'climber-1',
      addedByUser: { id: 'climber-1', username: 'Public climber' },
      tickedBy: ['climber-1', 'climber-2'],
      suggested: false,
    } as unknown as Parameters<typeof redactQueueItem>[0];
    const redacted = await redactQueueItem(item, 'stranger', 'session-1');
    expect(redacted.addedBy).toBeUndefined();
    expect(redacted.addedByUser).toBeUndefined();
    expect(redacted.tickedBy).toEqual(['climber-2']);
  });
});

describe('one lookup per session projection', () => {
  const queueItem = (uuid: string, addedBy: string, tickedBy: string[]) =>
    ({
      uuid,
      climb: { uuid: display.climbUuid, name: 'A climb' },
      addedBy,
      addedByUser: { id: addedBy, username: addedBy },
      tickedBy,
      suggested: false,
    }) as unknown as Parameters<typeof redactQueueItem>[0];
  const ctx = { connectionId: 'conn-1', userId: 'viewer', sessionId: 'session-1', isAuthenticated: true } as Parameters<
    typeof boardSessionPrivacyResolvers.ClimbQueueItem.addedBy
  >[2];

  it('names the viewer to themselves without placing the session', async () => {
    expect(await sessionVisibleUserIds(['viewer', null, 'viewer'], 'viewer', 'session-1')).toEqual(new Set(['viewer']));
    expect(sessionBoard.resolve).not.toHaveBeenCalled();
    expect(privacy.visibleActivityUserIdsByBoard).not.toHaveBeenCalled();
  });

  it('answers every field of every queue item and roster entry resolved together with one board resolution and one query', async () => {
    privacy.visibleActivityUserIdsByBoard.mockImplementation(async (rows: readonly BoardRow[]) =>
      rows.map((row) => new Set(row.userIds.filter((userId) => userId === 'climber-2'))),
    );
    const items = [
      queueItem('queue-1', 'climber-1', ['climber-2']),
      queueItem('queue-2', 'climber-2', []),
      queueItem('queue-3', 'climber-3', ['climber-1', 'climber-2']),
    ];
    const { ClimbQueueItem, SessionUser } = boardSessionPrivacyResolvers;
    const rosterUser = (userId: string) =>
      ({ id: userId, userId, username: userId, isLeader: false, connectionState: 'CONNECTED' }) as SessionUser;
    // graphql-js starts every field of every list item in one synchronous pass.
    const [addedBy, addedByUser, tickedBy, usernames] = await Promise.all([
      Promise.all(items.map((item) => ClimbQueueItem.addedBy(item, undefined, ctx))),
      Promise.all(items.map((item) => ClimbQueueItem.addedByUser(item, undefined, ctx))),
      Promise.all(items.map((item) => ClimbQueueItem.tickedBy(item, undefined, ctx))),
      Promise.all(['climber-1', 'climber-2'].map((userId) => SessionUser.username(rosterUser(userId), undefined, ctx))),
    ]);
    expect(addedBy).toEqual([undefined, 'climber-2', undefined]);
    expect(addedByUser.map((user) => user?.id)).toEqual([undefined, 'climber-2', undefined]);
    expect(tickedBy).toEqual([['climber-2'], [], ['climber-2']]);
    expect(usernames).toEqual(['', 'climber-2']);
    expect(sessionBoard.resolve).toHaveBeenCalledTimes(1);
    expect(privacy.visibleActivityUserIdsByBoard).toHaveBeenCalledTimes(1);
    expect(privacy.visibleActivityUserIdsByBoard).toHaveBeenCalledWith(
      [
        {
          rowIndex: 0,
          userIds: ['climber-1', 'climber-2', 'climber-3'],
          onBoard: { boardId: 12, sessionId: 'session-1' },
        },
      ],
      'viewer',
    );
    expect(privacy.canViewActivityIdentity).not.toHaveBeenCalled();

    // Nothing is cached past the projection: the next one asks again.
    await ClimbQueueItem.addedBy(items[0], undefined, ctx);
    expect(privacy.visibleActivityUserIdsByBoard).toHaveBeenCalledTimes(2);
  });
});

describe('legacy session event identity', () => {
  it('hides an unknown 64-hex account id instead of treating its shape as authorization', () => {
    const accountId = 'a'.repeat(64);
    expect(sessionEventParticipantId('session-1', accountId, new Map())).toBe(
      sessionParticipantId('session-1', accountId),
    );
    expect(sessionEventParticipantId('session-1', accountId, new Map())).not.toBe(accountId);
  });
  it('preserves roster-verified anonymous and opaque participant ids', () => {
    const known = new Map([
      ['anonymous-connection', 'anonymous-connection'],
      ['account-id', 'opaque-session-id'],
    ]);
    expect(sessionEventParticipantId('session-1', 'anonymous-connection', known)).toBe('anonymous-connection');
    expect(sessionEventParticipantId('session-1', 'account-id', known)).toBe('opaque-session-id');
  });
});
