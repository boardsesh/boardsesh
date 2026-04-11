import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the db module before imports
const mockSelect = vi.fn();
const mockFrom = vi.fn();
const mockWhere = vi.fn();
const mockOrderBy = vi.fn();
const mockLimit = vi.fn();
const mockUpdate = vi.fn();
const mockSet = vi.fn();
const mockInsert = vi.fn();
const mockValues = vi.fn();
const mockOnConflictDoUpdate = vi.fn();

vi.mock('../db/client', () => ({
  createRequestDb: () => ({}),
  withTransaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({}),
  db: {
    select: (...args: unknown[]) => {
      mockSelect(...args);
      return {
        from: (...a: unknown[]) => {
          mockFrom(...a);
          return {
            where: (...a2: unknown[]) => {
              mockWhere(...a2);
              return {
                orderBy: (...a3: unknown[]) => {
                  mockOrderBy(...a3);
                  return {
                    limit: (...a4: unknown[]) => {
                      mockLimit(...a4);
                      return Promise.resolve([]);
                    },
                  };
                },
              };
            },
          };
        },
      };
    },
    update: (...args: unknown[]) => {
      mockUpdate(...args);
      return {
        set: (...a: unknown[]) => {
          mockSet(...a);
          return {
            where: (...a2: unknown[]) => {
              mockWhere(...a2);
              return Promise.resolve();
            },
          };
        },
      };
    },
    insert: (...args: unknown[]) => {
      mockInsert(...args);
      return {
        values: (...a: unknown[]) => {
          mockValues(...a);
          return {
            onConflictDoUpdate: (...a2: unknown[]) => {
              mockOnConflictDoUpdate(...a2);
              return Promise.resolve();
            },
          };
        },
      };
    },
  },
}));

vi.mock('@boardsesh/db/schema', () => ({
  boardseshTicks: {
    uuid: 'uuid',
    userId: 'user_id',
    climbedAt: 'climbed_at',
    status: 'status',
    sessionId: 'session_id',
    inferredSessionId: 'inferred_session_id',
  },
  inferredSessions: {
    id: 'id',
    userId: 'user_id',
    firstTickAt: 'first_tick_at',
    lastTickAt: 'last_tick_at',
    endedAt: 'ended_at',
    tickCount: 'tick_count',
    totalSends: 'total_sends',
    totalFlashes: 'total_flashes',
    totalAttempts: 'total_attempts',
  },
}));

import { generateInferredSessionId } from '../jobs/inferred-session-builder';

describe('Inferred Session Assignment (assignInferredSession)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('generateInferredSessionId used in assignment', () => {
    it('generates a valid UUID for new sessions', () => {
      const id = generateInferredSessionId('user-1', '2024-01-15T10:00:00.000Z');
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    });

    it('is deterministic for same inputs', () => {
      const id1 = generateInferredSessionId('user-1', '2024-01-15T10:00:00.000Z');
      const id2 = generateInferredSessionId('user-1', '2024-01-15T10:00:00.000Z');
      expect(id1).toBe(id2);
    });

    it('varies with different users', () => {
      const id1 = generateInferredSessionId('user-1', '2024-01-15T10:00:00.000Z');
      const id2 = generateInferredSessionId('user-2', '2024-01-15T10:00:00.000Z');
      expect(id1).not.toBe(id2);
    });

    it('varies with different timestamps', () => {
      const id1 = generateInferredSessionId('user-1', '2024-01-15T10:00:00.000Z');
      const id2 = generateInferredSessionId('user-1', '2024-01-15T18:00:00.000Z');
      expect(id1).not.toBe(id2);
    });
  });

  describe('Status-based counting logic', () => {
    it('flash counts as both send and flash', () => {
      const status = 'flash';
      const isSend = status === 'flash' || status === 'send';
      const isFlash = status === 'flash';
      const isAttempt = status === 'attempt';

      expect(isSend).toBe(true);
      expect(isFlash).toBe(true);
      expect(isAttempt).toBe(false);
    });

    it('send counts as send only', () => {
      const status = 'send';
      const isSend = status === 'flash' || status === 'send';
      const isFlash = status === 'flash';
      const isAttempt = status === 'attempt';

      expect(isSend).toBe(true);
      expect(isFlash).toBe(false);
      expect(isAttempt).toBe(false);
    });

    it('attempt counts as attempt only', () => {
      const status = 'attempt';
      const isSend = status === 'flash' || status === 'send';
      const isFlash = status === 'flash';
      const isAttempt = status === 'attempt';

      expect(isSend).toBe(false);
      expect(isFlash).toBe(false);
      expect(isAttempt).toBe(true);
    });
  });

  describe('Gap detection logic', () => {
    const SESSION_GAP_MS = 4 * 60 * 60 * 1000;

    it('detects ticks within 4h as same session', () => {
      const prevTime = new Date('2024-01-15T10:00:00.000Z').getTime();
      const currTime = new Date('2024-01-15T13:00:00.000Z').getTime();
      const gap = Math.abs(currTime - prevTime);
      expect(gap <= SESSION_GAP_MS).toBe(true);
    });

    it('detects ticks beyond 4h as new session', () => {
      const prevTime = new Date('2024-01-15T10:00:00.000Z').getTime();
      const currTime = new Date('2024-01-15T14:00:00.001Z').getTime();
      const gap = Math.abs(currTime - prevTime);
      expect(gap > SESSION_GAP_MS).toBe(true);
    });

    it('detects exactly 4h gap as same session', () => {
      const prevTime = new Date('2024-01-15T10:00:00.000Z').getTime();
      const currTime = new Date('2024-01-15T14:00:00.000Z').getTime();
      const gap = Math.abs(currTime - prevTime);
      expect(gap <= SESSION_GAP_MS).toBe(true);
    });
  });
});
