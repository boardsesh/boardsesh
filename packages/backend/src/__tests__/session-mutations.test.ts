import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import { sessionEditMutations } from '../graphql/resolvers/social/session-mutations';
import { db } from '../db/client';

vi.mock('../db/client', () => {
  const mockDb = {
    select: vi.fn(),
    insert: vi.fn(),
  };
  return { db: mockDb };
});

function makeCtx(userId = 'user-1'): ConnectionContext {
  return {
    isAuthenticated: true,
    userId,
  } as ConnectionContext;
}

function makeUnauthCtx(): ConnectionContext {
  return {
    connectionId: 'conn-unauth',
    isAuthenticated: false,
    userId: undefined,
  };
}

function setupSelectResults(results: unknown[][]) {
  let index = 0;
  const limit = vi.fn().mockImplementation(() => Promise.resolve(results[index++] ?? []));
  const where = vi.fn().mockReturnValue({ limit });
  const from = vi.fn().mockReturnValue({ where });
  (db.select as ReturnType<typeof vi.fn>).mockReturnValue({ from });
}

function setupInsert() {
  const onConflictDoUpdate = vi.fn().mockResolvedValue(undefined);
  const values = vi.fn().mockReturnValue({ onConflictDoUpdate });
  (db.insert as ReturnType<typeof vi.fn>).mockReturnValue({ values });
  return { values, onConflictDoUpdate };
}

describe('Session Mutation Resolvers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupInsert();
  });

  describe('setSessionHealthKitWorkoutId', () => {
    it('rejects unauthenticated users', async () => {
      await expect(
        sessionEditMutations.setSessionHealthKitWorkoutId(
          null,
          { sessionId: 'session-1', workoutId: 'workout-1' },
          makeUnauthCtx(),
        ),
      ).rejects.toThrow('Authentication required');
    });

    it('rejects missing sessions', async () => {
      setupSelectResults([[]]);

      await expect(
        sessionEditMutations.setSessionHealthKitWorkoutId(
          null,
          { sessionId: 'session-1', workoutId: 'workout-1' },
          makeCtx(),
        ),
      ).rejects.toThrow('Session not found');
    });

    it('rejects non-participants who did not create the session', async () => {
      setupSelectResults([[{ createdByUserId: 'owner-user' }], []]);

      await expect(
        sessionEditMutations.setSessionHealthKitWorkoutId(
          null,
          { sessionId: 'session-1', workoutId: 'workout-1' },
          makeCtx('other-user'),
        ),
      ).rejects.toThrow('Not a participant of this session');
    });

    it('stores a viewer-specific HealthKit workout for the creator', async () => {
      setupSelectResults([[{ createdByUserId: 'user-1' }]]);
      const { values, onConflictDoUpdate } = setupInsert();

      await expect(
        sessionEditMutations.setSessionHealthKitWorkoutId(
          null,
          { sessionId: 'session-1', workoutId: 'workout-1' },
          makeCtx(),
        ),
      ).resolves.toBe(true);

      expect(values).toHaveBeenCalledWith({
        sessionId: 'session-1',
        userId: 'user-1',
        workoutId: 'workout-1',
        updatedAt: expect.any(Date),
      });
      expect(onConflictDoUpdate).toHaveBeenCalledWith({
        target: expect.any(Array),
        set: {
          workoutId: 'workout-1',
          updatedAt: expect.any(Date),
        },
      });
    });

    it('stores a viewer-specific HealthKit workout for a participant with ticks', async () => {
      setupSelectResults([[{ createdByUserId: 'owner-user' }], [{ uuid: 'tick-1' }]]);
      const { values } = setupInsert();

      await expect(
        sessionEditMutations.setSessionHealthKitWorkoutId(
          null,
          { sessionId: 'session-1', workoutId: 'workout-1' },
          makeCtx('participant-user'),
        ),
      ).resolves.toBe(true);

      expect(values).toHaveBeenCalledWith({
        sessionId: 'session-1',
        userId: 'participant-user',
        workoutId: 'workout-1',
        updatedAt: expect.any(Date),
      });
    });
  });
});
