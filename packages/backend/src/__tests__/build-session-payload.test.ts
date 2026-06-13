/**
 * Direct unit tests for `buildSessionPayload` — the helper introduced by
 * Phase 3.1 of the queue-control-bar pivot simplify pass.
 *
 * The helper is now the canonical path for every Session-returning
 * resolver (joinSession, takeControl, releaseControl, confirmClimbOnWall,
 * setSessionBoardSerial, queries.session). The undefined-vs-explicit-null
 * override semantics + the `cleared ? { driverParticipantId: null } : {}`
 * pattern from `releaseControl` are subtle enough that indirect coverage
 * through the resolver tests isn't enough — this file exercises the
 * helper's behaviour directly.
 *
 * Behaviours verified:
 *  1. Default (no overrides) — all six fetchers fire in parallel; the
 *     payload shape mirrors what the pre-helper resolvers built by hand.
 *  2. `inputs.users` / `inputs.queueState` / `inputs.sessionData` /
 *     `inputs.driverParticipantId` / `inputs.lastConnectedBoardSerial` /
 *     `inputs.leaderConnectionId` — each short-circuits its corresponding
 *     fetch when supplied, no Redis round-trip.
 *  3. `inputs.driverParticipantId: null` is honoured as a real override
 *     (the releaseControl `cleared ? { driverParticipantId: null } : {}`
 *     pattern) — `getSessionDriverParticipantId` is NOT called.
 *  4. `inputs.isLeader` short-circuits the `leaderConnectionId` fetch
 *     entirely — it's only ever consumed to compute `isLeader`, so
 *     fetching it just to discard the value is wasted Redis traffic.
 *  5. `name` / `boardPath` overrides — fall back to `sessionData?.name` /
 *     `sessionData?.boardPath` when omitted.
 *  6. `participantId` falls through `inputs.participantId` →
 *     `ctx.participantId` → `ctx.connectionId` → `''`.
 *  7. `isPublic` defaults to `true` when `sessionData` is null (the
 *     session-cleanup race documented inline in the helper).
 */

import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import type { ConnectionContext } from '@boardsesh/shared-schema';

const getSessionUsersMock = vi.fn();
const getSessionByIdMock = vi.fn();
const getQueueStateMock = vi.fn();
const getSessionDriverParticipantIdMock = vi.fn();
const getSessionBoardSerialMock = vi.fn();
const getSessionLeaderConnectionIdMock = vi.fn();
const getWallConnectionsMock = vi.fn();

vi.mock('../services/room-manager', () => ({
  roomManager: {
    getSessionUsers: (...args: unknown[]) => getSessionUsersMock(...args),
    getSessionById: (...args: unknown[]) => getSessionByIdMock(...args),
    getQueueState: (...args: unknown[]) => getQueueStateMock(...args),
    getSessionDriverParticipantId: (...args: unknown[]) => getSessionDriverParticipantIdMock(...args),
    getSessionBoardSerial: (...args: unknown[]) => getSessionBoardSerialMock(...args),
    getSessionLeaderConnectionId: (...args: unknown[]) => getSessionLeaderConnectionIdMock(...args),
    getWallConnections: (...args: unknown[]) => getWallConnectionsMock(...args),
  },
}));

const { buildSessionPayload } = await import('../graphql/resolvers/sessions/helpers');

function makeCtx(overrides: Partial<ConnectionContext> = {}): ConnectionContext {
  return {
    connectionId: 'conn-1',
    transport: 'ws',
    sessionId: 'session-1',
    participantId: 'participant-1',
    userId: undefined,
    isAuthenticated: false,
    ...overrides,
  };
}

const sampleSessionData = {
  id: 'session-1',
  name: 'Tuesday sesh',
  boardPath: '/kilter/1/2/3/40',
  goal: 'project the V6',
  isPublic: false,
  startedAt: new Date('2026-05-18T12:00:00Z'),
  endedAt: null,
  isPermanent: false,
  color: '#ff00aa',
  createdByUserId: 'user-1',
};

const sampleQueueState = {
  sequence: 5,
  stateHash: 'hash-5',
  queue: [],
  currentClimbQueueItem: null,
  version: 3,
};

beforeEach(() => {
  getSessionUsersMock
    .mockReset()
    .mockResolvedValue([
      { id: 'participant-1', username: 'me', isLeader: true, connectionState: 'CONNECTED' as const },
    ]);
  getSessionByIdMock.mockReset().mockResolvedValue(sampleSessionData);
  getQueueStateMock.mockReset().mockResolvedValue(sampleQueueState);
  getSessionDriverParticipantIdMock.mockReset().mockResolvedValue('participant-2');
  getSessionBoardSerialMock.mockReset().mockResolvedValue('SERIAL-123');
  getWallConnectionsMock.mockReset().mockResolvedValue(new Map([[7, 'participant-2']]));
  getSessionLeaderConnectionIdMock.mockReset().mockResolvedValue('conn-1');
});

describe('buildSessionPayload — defaults (no overrides)', () => {
  it('returns the full 17-field Session shape with values from the room manager', async () => {
    const payload = await buildSessionPayload('session-1', makeCtx());

    expect(payload).toEqual({
      id: 'session-1',
      name: 'Tuesday sesh',
      boardPath: '/kilter/1/2/3/40',
      users: [{ id: 'participant-1', username: 'me', isLeader: true, connectionState: 'CONNECTED' as const }],
      queueState: {
        sequence: 5,
        stateHash: 'hash-5',
        queue: [],
        currentClimbQueueItem: null,
      },
      isLeader: true, // leaderConnectionId === ctx.connectionId
      driverParticipantId: 'participant-2',
      wallConnections: [{ boardId: 7, holderParticipantId: 'participant-2' }],
      lastConnectedBoardSerial: 'SERIAL-123',
      clientId: 'conn-1',
      participantId: 'participant-1',
      goal: 'project the V6',
      isPublic: false,
      startedAt: '2026-05-18T12:00:00.000Z',
      endedAt: null,
      isPermanent: false,
      color: '#ff00aa',
    });
  });

  it('fires all seven room-manager reads in parallel', async () => {
    await buildSessionPayload('session-1', makeCtx());

    expect(getSessionUsersMock).toHaveBeenCalledWith('session-1');
    expect(getSessionByIdMock).toHaveBeenCalledWith('session-1');
    expect(getQueueStateMock).toHaveBeenCalledWith('session-1');
    expect(getSessionDriverParticipantIdMock).toHaveBeenCalledWith('session-1');
    expect(getSessionBoardSerialMock).toHaveBeenCalledWith('session-1');
    expect(getSessionLeaderConnectionIdMock).toHaveBeenCalledWith('session-1');
    expect(getWallConnectionsMock).toHaveBeenCalledWith('session-1');
  });
});

describe('buildSessionPayload — override short-circuits', () => {
  it('skips getSessionUsers when inputs.users is supplied', async () => {
    const prefetched = [{ id: 'a', username: 'a', isLeader: false, connectionState: 'CONNECTED' as const }];
    const payload = await buildSessionPayload('session-1', makeCtx(), { users: prefetched });

    expect(getSessionUsersMock).not.toHaveBeenCalled();
    expect(payload.users).toBe(prefetched);
  });

  it('skips getQueueState when inputs.queueState is supplied', async () => {
    const prefetched = {
      sequence: 99,
      stateHash: 'fresh',
      queue: [],
      currentClimbQueueItem: null,
    };
    const payload = await buildSessionPayload('session-1', makeCtx(), { queueState: prefetched });

    expect(getQueueStateMock).not.toHaveBeenCalled();
    expect(payload.queueState).toEqual(prefetched);
  });

  it('skips getSessionById when inputs.sessionData is supplied (including explicit null)', async () => {
    const payload = await buildSessionPayload('session-1', makeCtx(), { sessionData: null });

    expect(getSessionByIdMock).not.toHaveBeenCalled();
    // Falls back to defaults when sessionData is null
    expect(payload.name).toBeNull();
    expect(payload.boardPath).toBe('');
    expect(payload.goal).toBeNull();
    expect(payload.isPublic).toBe(true); // session-cleanup race default
    expect(payload.startedAt).toBeNull();
    expect(payload.endedAt).toBeNull();
    expect(payload.isPermanent).toBe(false);
    expect(payload.color).toBeNull();
  });

  it('honours inputs.driverParticipantId: null (the releaseControl cleared shortcut)', async () => {
    // This is the subtle one — releaseControl spreads
    // `...(cleared ? { driverParticipantId: null } : {})`, so the override
    // is a real null, not an absent key. The fetcher should NOT run.
    const payload = await buildSessionPayload('session-1', makeCtx(), { driverParticipantId: null });

    expect(getSessionDriverParticipantIdMock).not.toHaveBeenCalled();
    expect(payload.driverParticipantId).toBeNull();
  });

  it('skips getSessionBoardSerial when inputs.lastConnectedBoardSerial is supplied (incl null)', async () => {
    const payload = await buildSessionPayload('session-1', makeCtx(), { lastConnectedBoardSerial: null });

    expect(getSessionBoardSerialMock).not.toHaveBeenCalled();
    expect(payload.lastConnectedBoardSerial).toBeNull();
  });

  it('skips getSessionLeaderConnectionId when inputs.isLeader is supplied', async () => {
    // `leaderConnectionId` only feeds `isLeader` — fetching it just to
    // discard the value is wasted traffic. This was flagged in PR review.
    const payload = await buildSessionPayload('session-1', makeCtx(), { isLeader: false });

    expect(getSessionLeaderConnectionIdMock).not.toHaveBeenCalled();
    expect(payload.isLeader).toBe(false);
  });

  it('skips getSessionLeaderConnectionId when inputs.leaderConnectionId is supplied (no inputs.isLeader)', async () => {
    const payload = await buildSessionPayload('session-1', makeCtx(), { leaderConnectionId: 'some-other-conn' });

    expect(getSessionLeaderConnectionIdMock).not.toHaveBeenCalled();
    // isLeader computed against ctx.connectionId === 'conn-1'
    expect(payload.isLeader).toBe(false);
  });
});

describe('buildSessionPayload — name / boardPath / participantId fallthrough', () => {
  it('uses inputs.name when supplied, otherwise sessionData.name, otherwise null', async () => {
    const fromInput = await buildSessionPayload('session-1', makeCtx(), { name: 'override' });
    expect(fromInput.name).toBe('override');

    const fromSession = await buildSessionPayload('session-1', makeCtx(), {});
    expect(fromSession.name).toBe('Tuesday sesh');

    const fromNull = await buildSessionPayload('session-1', makeCtx(), { sessionData: null });
    expect(fromNull.name).toBeNull();
  });

  it('uses inputs.boardPath when supplied, otherwise sessionData.boardPath, otherwise empty string', async () => {
    const fromInput = await buildSessionPayload('session-1', makeCtx(), { boardPath: '/tension/1/2/3/40' });
    expect(fromInput.boardPath).toBe('/tension/1/2/3/40');

    const fromSession = await buildSessionPayload('session-1', makeCtx(), {});
    expect(fromSession.boardPath).toBe('/kilter/1/2/3/40');

    const fromNull = await buildSessionPayload('session-1', makeCtx(), { sessionData: null });
    expect(fromNull.boardPath).toBe('');
  });

  it('participantId falls through: inputs.participantId → ctx.participantId → ctx.connectionId → ""', async () => {
    const fromInput = await buildSessionPayload('session-1', makeCtx(), { participantId: 'override' });
    expect(fromInput.participantId).toBe('override');

    const fromCtx = await buildSessionPayload('session-1', makeCtx());
    expect(fromCtx.participantId).toBe('participant-1');

    const fromConnection = await buildSessionPayload(
      'session-1',
      makeCtx({ participantId: undefined, connectionId: 'conn-fallback' }),
    );
    expect(fromConnection.participantId).toBe('conn-fallback');

    const empty = await buildSessionPayload(
      'session-1',
      makeCtx({ participantId: undefined, connectionId: '' as unknown as string }),
    );
    expect(empty.participantId).toBe('');
  });

  it('clientId override accepts null explicitly (queries.session passes empty string, the type allows null)', async () => {
    const fromInput = await buildSessionPayload('session-1', makeCtx(), { clientId: '' });
    expect(fromInput.clientId).toBe('');

    const fromCtx = await buildSessionPayload('session-1', makeCtx({ connectionId: 'conn-xyz' }));
    expect(fromCtx.clientId).toBe('conn-xyz');
  });
});
