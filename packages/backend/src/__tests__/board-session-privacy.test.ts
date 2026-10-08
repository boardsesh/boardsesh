import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import type { BoardPresenceClimb, BoardPresenceStats, SessionUser } from '@boardsesh/shared-schema';

vi.hoisted(() => vi.resetModules());

const privacy = vi.hoisted(() => ({ canViewActivityIdentity: vi.fn(), canViewContent: vi.fn() }));
const provenance = vi.hoisted(() => ({
  rows: [] as { seq: number; sessionId: string | null; identityPolicyVersion: number }[],
  climbs: [] as { uuid: string; userId: string | null; isListed: boolean; isDraft: boolean }[],
}));
vi.mock('../services/privacy', () => privacy);
vi.mock('../db/client', async () => {
  const { boardClimbs } = await import('@boardsesh/db/schema');
  return {
    db: {
      select: () => ({
        from: (table: unknown) => ({
          where: async () => (table === boardClimbs ? provenance.climbs : provenance.rows),
        }),
      }),
    },
  };
});

const { redactBoardClimbs, redactBoardStats, redactSessionUsers, sessionParticipantId, sessionEventParticipantId } =
  await import('../services/board-session-privacy');

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
  provenance.rows = [];
  provenance.climbs = [{ uuid: display.climbUuid, userId: null, isListed: true, isDraft: false }];
  privacy.canViewContent.mockResolvedValue(true);
});
afterEach(() => vi.unstubAllEnvs());

describe('board history identity', () => {
  it('keeps the climb, time and order while concealing attribution from a stranger', async () => {
    const [hidden] = await redactBoardClimbs([display], 123, 'stranger');
    expect(hidden).toMatchObject({
      climbUuid: display.climbUuid,
      name: display.name,
      seq: 7,
      sentAt: display.sentAt,
      sentByUserId: null,
      sentByDisplayName: null,
      sentByAvatarUrl: null,
    });
    expect(privacy.canViewActivityIdentity).toHaveBeenCalledWith('climber-1', 'stranger', { sessionId: 'session-1' });
  });
  it('rechecks an existing cached display after a follower is revoked', async () => {
    privacy.canViewActivityIdentity.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    expect((await redactBoardClimbs([display], 123, 'follower'))[0].sentByUserId).toBe('climber-1');
    expect((await redactBoardClimbs([display], 123, 'follower'))[0].sentByUserId).toBeNull();
    expect(display.sentByUserId).toBe('climber-1');
  });
  it('does not infer public attribution for unmatched historical rows', async () => {
    privacy.canViewActivityIdentity.mockResolvedValue(true);
    const historical = { ...display, sessionId: null, identityPolicyVersion: undefined };
    expect((await redactBoardClimbs([historical], 123, 'stranger'))[0].sentByUserId).toBeNull();
    expect((await redactBoardClimbs([historical], 123, 'climber-1'))[0].sentByUserId).toBe('climber-1');
  });
  it('uses durable session provenance when Redis lacks it', async () => {
    provenance.rows = [{ seq: 7, sessionId: 'private-session', identityPolicyVersion: 1 }];
    await redactBoardClimbs([{ ...display, sessionId: undefined }], 123, 'viewer');
    expect(privacy.canViewActivityIdentity).toHaveBeenCalledWith('climber-1', 'viewer', {
      sessionId: 'private-session',
    });
  });
  it('retains chronology but removes private climb content', async () => {
    // The primary SQL policy excludes the inaccessible authored source row.
    provenance.climbs = [];
    const [hidden] = await redactBoardClimbs(
      [{ ...display, frames: 'private-holds', setter: 'Secret setter' }],
      123,
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
      sessionId: 'session-1',
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
