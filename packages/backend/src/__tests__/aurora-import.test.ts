import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ConnectionContext } from '@boardsesh/shared-schema';

// ---------------------------------------------------------------------------
// Mock all heavy dependencies before importing the module under test.
// vi.mock is hoisted by vitest, so we cannot reference outer variables.
// Use factory functions that return fresh mocks.
// ---------------------------------------------------------------------------

vi.mock('@boardsesh/db/schema', () => ({
  boardClimbs: { uuid: 'uuid', name: 'name', boardType: 'board_type', isListed: 'is_listed', isDraft: 'is_draft' },
  boardClimbStats: { climbUuid: 'climb_uuid', boardType: 'board_type', ascensionistCount: 'ascensionist_count' },
  boardseshTicks: {
    $inferInsert: {},
    auroraId: 'aurora_id',
    userId: 'user_id',
    boardType: 'board_type',
    climbUuid: 'climb_uuid',
    angle: 'angle',
    climbedAt: 'climbed_at',
  },
  auroraUsernameClaims: {
    userId: 'user_id',
    boardType: 'board_type',
    auroraUsername: 'aurora_username',
  },
  playlists: { id: 'id', auroraId: 'aurora_id' },
  playlistClimbs: { playlistId: 'playlist_id' },
  playlistOwnership: {},
}));

vi.mock('drizzle-orm/neon-serverless', () => ({
  drizzle: vi.fn(() => ({
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({
        onConflictDoUpdate: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{ id: 1 }]),
        }),
        onConflictDoNothing: vi.fn().mockResolvedValue(undefined),
      }),
    }),
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        leftJoin: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([]),
        }),
        where: vi.fn().mockResolvedValue([]),
      }),
    }),
    delete: vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue(undefined),
    }),
  })),
}));

vi.mock('@boardsesh/db/client', () => ({
  createPool: vi.fn(() => ({
    connect: vi.fn().mockResolvedValue({
      release: vi.fn(),
      query: vi.fn().mockResolvedValue(undefined),
    }),
  })),
  createDb: vi.fn(() => ({})),
}));

vi.mock('../db/client', () => ({
  db: {
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({
        onConflictDoUpdate: vi.fn().mockResolvedValue(undefined),
      }),
    }),
  },
}));

vi.mock('../jobs/inferred-session-builder', () => ({
  runInferredSessionBuilderBatched: vi.fn().mockResolvedValue({ ticksAssigned: 0 }),
}));

// Mock transitive dependencies pulled in by shared/helpers
vi.mock('@boardsesh/db/schema/app', () => ({
  esp32Controllers: {},
}));

vi.mock('../utils/rate-limiter', () => ({
  checkRateLimit: vi.fn(),
}));

vi.mock('../utils/redis-rate-limiter', () => ({
  checkRateLimitRedis: vi.fn(),
}));

vi.mock('../graphql/context', () => ({
  getContext: vi.fn(),
}));

vi.mock('../services/distributed-state', () => ({
  getDistributedState: vi.fn().mockReturnValue(null),
}));

// ---------------------------------------------------------------------------
// Import the module under test AFTER all mocks are set up
// ---------------------------------------------------------------------------

import { auroraImportMutations } from '../graphql/resolvers/aurora-import/mutations';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeContext(overrides: Partial<ConnectionContext> = {}): ConnectionContext {
  return {
    connectionId: 'test-conn',
    isAuthenticated: true,
    userId: 'test-user-123',
    sessionId: undefined,
    ...overrides,
  } as ConnectionContext;
}

function makeValidInput(overrides: Record<string, unknown> = {}) {
  return {
    boardType: 'kilter',
    data: {
      user: { username: 'testuser' },
      ascents: [],
      attempts: [],
      circuits: [],
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('auroraImportMutations.importAuroraJson', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('authentication', () => {
    it('throws when not authenticated', async () => {
      const ctx = makeContext({ isAuthenticated: false });
      const input = makeValidInput();

      await expect(
        auroraImportMutations.importAuroraJson(undefined, { input }, ctx),
      ).rejects.toThrow('Authentication required');
    });

    it('does not throw when authenticated', async () => {
      const ctx = makeContext({ isAuthenticated: true, userId: 'user-1' });
      const input = makeValidInput();

      await expect(
        auroraImportMutations.importAuroraJson(undefined, { input }, ctx),
      ).resolves.toBeDefined();
    });
  });

  describe('input validation', () => {
    it('throws on invalid boardType', async () => {
      const ctx = makeContext();
      const input = makeValidInput({ boardType: 'invalid' });

      await expect(
        auroraImportMutations.importAuroraJson(undefined, { input }, ctx),
      ).rejects.toThrow('Invalid import data');
    });

    it('throws when user object is missing', async () => {
      const ctx = makeContext();
      const input = { boardType: 'kilter', data: { ascents: [], attempts: [], circuits: [] } };

      await expect(
        auroraImportMutations.importAuroraJson(undefined, { input }, ctx),
      ).rejects.toThrow('Invalid import data');
    });

    it('throws when user.username is missing', async () => {
      const ctx = makeContext();
      const input = {
        boardType: 'kilter',
        data: { user: { email_address: 'test@test.com' }, ascents: [], attempts: [], circuits: [] },
      };

      await expect(
        auroraImportMutations.importAuroraJson(undefined, { input }, ctx),
      ).rejects.toThrow('Invalid import data');
    });

    it('accepts valid kilter boardType', async () => {
      const ctx = makeContext();
      const input = makeValidInput({ boardType: 'kilter' });

      const result = await auroraImportMutations.importAuroraJson(undefined, { input }, ctx);
      expect(result).toBeDefined();
      expect(result.claimedUsername).toBe('testuser');
    });

    it('accepts valid tension boardType', async () => {
      const ctx = makeContext();
      const input = makeValidInput({ boardType: 'tension' });

      const result = await auroraImportMutations.importAuroraJson(undefined, { input }, ctx);
      expect(result).toBeDefined();
    });
  });

  describe('return structure', () => {
    it('returns correct ImportResult structure on success', async () => {
      const ctx = makeContext();
      const input = makeValidInput();

      const result = await auroraImportMutations.importAuroraJson(undefined, { input }, ctx);

      expect(result).toHaveProperty('ascents');
      expect(result).toHaveProperty('attempts');
      expect(result).toHaveProperty('circuits');
      expect(result).toHaveProperty('unresolvedClimbs');
      expect(result).toHaveProperty('claimedUsername');

      expect(result.ascents).toEqual({ imported: 0, skipped: 0, failed: 0 });
      expect(result.attempts).toEqual({ imported: 0, skipped: 0, failed: 0 });
      expect(result.circuits).toEqual({ imported: 0, skipped: 0, failed: 0 });
      expect(result.unresolvedClimbs).toEqual([]);
      expect(result.claimedUsername).toBe('testuser');
    });

    it('reports unresolved climbs when climb names cannot be matched', async () => {
      const ctx = makeContext();
      const input = makeValidInput({
        data: {
          user: { username: 'testuser' },
          ascents: [
            { climb: 'NonExistent Route', angle: 40, count: 1, stars: 3, climbed_at: '2024-01-01 12:00:00.000', created_at: '2024-01-01 12:00:00.000', grade: '6a' },
          ],
          attempts: [],
          circuits: [],
        },
      });

      const result = await auroraImportMutations.importAuroraJson(undefined, { input }, ctx);

      expect(result.unresolvedClimbs).toContain('NonExistent Route');
      expect(result.ascents.failed).toBe(1);
    });
  });
});
