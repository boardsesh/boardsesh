import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import type { BoardPresenceClimb, BoardPresenceStats, SessionUser } from '@boardsesh/shared-schema';

vi.hoisted(() => vi.resetModules());

const privacy = vi.hoisted(() => ({
  canViewActivityIdentity: vi.fn(),
  canViewContent: vi.fn(),
  visibleActivityUserIds: vi.fn(),
}));
const readable = vi.hoisted(() => ({
  climbs: [] as { uuid: string; userId: string | null; isListed: boolean; isDraft: boolean }[],
}));
vi.mock('../services/privacy', () => privacy);
vi.mock('../db/client', () => ({
  db: { select: () => ({ from: () => ({ where: async () => readable.climbs }) }) },
}));

const {
  redactBoardClimbs,
  redactBoardHolder,
  redactBoardIdentity,
  redactBoardStats,
  redactSessionUsers,
  sessionParticipantId,
  sessionEventParticipantId,
} = await import('../services/board-session-privacy');

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
  readable.climbs = [{ uuid: display.climbUuid, userId: null, isListed: true, isDraft: false }];
  privacy.canViewContent.mockResolvedValue(true);
});
afterEach(() => vi.unstubAllEnvs());

describe('board history identity', () => {
  it('keeps the climb, time and order while concealing attribution from a stranger', async () => {
    const [hidden] = await redactBoardClimbs([display], 'stranger');
    expect(hidden).toMatchObject({
      climbUuid: display.climbUuid,
      name: display.name,
      seq: 7,
      sentAt: display.sentAt,
      sentByUserId: null,
      sentByDisplayName: null,
      sentByAvatarUrl: null,
    });
    // The sender's account decides; the session the send was in is not consulted.
    expect(privacy.visibleActivityUserIds).toHaveBeenCalledWith(['climber-1'], 'stranger');
  });
  it('checks every sender on a page in one lookup', async () => {
    privacy.visibleActivityUserIds.mockResolvedValue(new Set(['climber-1']));
    const page = [display, { ...display, seq: 8, sentByUserId: 'climber-2' }, { ...display, seq: 9 }];
    const redacted = await redactBoardClimbs(page, 'viewer');
    expect(redacted.map((climb) => climb.sentByUserId)).toEqual(['climber-1', null, 'climber-1']);
    expect(privacy.visibleActivityUserIds).toHaveBeenCalledTimes(1);
    expect(privacy.canViewActivityIdentity).not.toHaveBeenCalled();
  });
  it('rechecks an existing cached display after a follower is revoked', async () => {
    privacy.visibleActivityUserIds.mockResolvedValueOnce(new Set(['climber-1'])).mockResolvedValueOnce(new Set());
    expect((await redactBoardClimbs([display], 'follower'))[0].sentByUserId).toBe('climber-1');
    expect((await redactBoardClimbs([display], 'follower'))[0].sentByUserId).toBeNull();
    expect(display.sentByUserId).toBe('climber-1');
  });
  it('names a historical row with no session or policy version by its climber account alone', async () => {
    const historical = { ...display, sessionId: null, identityPolicyVersion: undefined };
    privacy.visibleActivityUserIds.mockResolvedValue(new Set(['climber-1']));
    expect((await redactBoardClimbs([historical], 'stranger'))[0].sentByUserId).toBe('climber-1');
    privacy.visibleActivityUserIds.mockResolvedValue(new Set());
    expect((await redactBoardClimbs([historical], 'stranger'))[0].sentByUserId).toBeNull();
    expect(privacy.visibleActivityUserIds).toHaveBeenLastCalledWith(['climber-1'], 'stranger');
  });
  it('retains chronology but removes private climb content', async () => {
    // The primary SQL policy excludes the inaccessible authored source row.
    readable.climbs = [];
    const [hidden] = await redactBoardClimbs(
      [{ ...display, frames: 'private-holds', setter: 'Secret setter' }],
      'viewer',
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
    await redactBoardStats(stats, 'viewer');
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
    const hidden = await redactBoardStats(stats, 'viewer');
    expect(hidden).toMatchObject({
      climbsSentCount: 20,
      distinctClimbersCount: 4,
      hardestGrade: 'V8',
      hardestSend: { climbUuid: 'climb-1', grade: 'V8', sentByUserId: null, sentByDisplayName: null },
    });
  });
  it('hides retained private climb metadata after its author account is deleted', async () => {
    privacy.canViewContent.mockResolvedValue(false);
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
    expect(await redactBoardStats(stats, 'viewer')).toEqual({ ...stats, hardestSend: null });
    expect(privacy.canViewContent).toHaveBeenCalledWith('viewer', 'climb', 'climb-1', null);
  });
});

describe('Bluetooth holder identity', () => {
  const holder = { userId: 'climber-1', displayName: 'Public climber', avatarUrl: 'https://example.test/a' };
  it('names the holder by their account privacy with no live session on the board', async () => {
    privacy.canViewActivityIdentity.mockResolvedValue(true);
    expect(await redactBoardHolder(holder, 'stranger')).toEqual(holder);
    expect(privacy.canViewActivityIdentity).toHaveBeenCalledWith('climber-1', 'stranger');
  });
  it('withholds a private holder from a viewer their account does not allow', async () => {
    expect(await redactBoardHolder(holder, 'stranger')).toEqual({
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
    privacy.canViewActivityIdentity.mockResolvedValue(true);
    const [visible] = await redactSessionUsers([user], 'approved-follower', 'session-1');
    expect(visible.userId).toBe(user.userId);
    expect(visible.username).toBe(user.username);
    expect(visible.id).not.toBe(user.userId);
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
