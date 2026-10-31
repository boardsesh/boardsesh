import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { sessionParticipantId } from '../services/board-session-privacy';

const { getContextMock, getClientMock, getDistributedStateMock } = vi.hoisted(() => ({
  getContextMock: vi.fn(),
  getClientMock: vi.fn(),
  getDistributedStateMock: vi.fn(),
}));

vi.mock('../graphql/context', () => ({ getContext: getContextMock }));
vi.mock('../services/room-manager', () => ({ roomManager: { getClient: getClientMock } }));
vi.mock('../services/distributed-state', () => ({ getDistributedState: getDistributedStateMock }));

import { resolveQueueMoverParticipantId } from '../services/queue-mover';

describe('server-bound queue mover (#7135)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    getDistributedStateMock.mockReturnValue(null);
  });

  it('reads the participant bound by JOIN after a buffered mutation captured its context', async () => {
    getContextMock.mockReturnValue({ sessionId: 'session', participantId: 'sam-participant' });
    expect(await resolveQueueMoverParticipantId({ connectionId: 'socket' }, 'session')).toBe('sam-participant');
  });

  it('uses the live room participant rather than a stale context identity', async () => {
    getClientMock.mockReturnValue({ sessionId: 'session', participantId: 'bound-participant' });
    expect(
      await resolveQueueMoverParticipantId(
        { connectionId: 'socket', sessionId: 'session', participantId: 'stale' },
        'session',
      ),
    ).toBe('bound-participant');
  });

  it('recovers a participant bound on another backend instance', async () => {
    getDistributedStateMock.mockReturnValue({
      getConnection: vi.fn().mockResolvedValue({ sessionId: 'session', participantId: 'distributed-participant' }),
    });
    expect(await resolveQueueMoverParticipantId({ connectionId: 'socket' }, 'session')).toBe('distributed-participant');
  });

  it('uses the session protocol identity rather than exposing an account UUID', async () => {
    const ctx = { connectionId: 'socket', sessionId: 'session', userId: 'account-uuid' };
    const participant = await resolveQueueMoverParticipantId(ctx, 'session');
    expect(participant).toBe(sessionParticipantId('session', 'account-uuid'));
    expect(participant).not.toBe(ctx.userId);
  });

  it('keeps an unknown recovered actor anonymous when the live lookup fails', async () => {
    getDistributedStateMock.mockReturnValue({
      getConnection: vi.fn().mockRejectedValue(new Error('Redis unavailable')),
    });
    expect(await resolveQueueMoverParticipantId({ connectionId: 'socket' }, 'session')).toBeNull();
  });
});
