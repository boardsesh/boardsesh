/**
 * Tests for createSession authentication behavior.
 *
 * Verifies that:
 * - Anonymous users can create non-discoverable (ephemeral) sessions
 * - Anonymous users cannot create discoverable sessions (auth required)
 * - Authenticated users can create both discoverable and non-discoverable sessions
 */

import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import { sessionMutations } from '../graphql/resolvers/sessions/mutations';
import { db } from '../db/client';
import * as privacy from '../services/privacy';

// Mock dependencies
vi.mock('../services/room-manager', () => ({
  roomManager: {
    joinSession: vi.fn().mockResolvedValue({
      clientId: 'client-1',
      isLeader: true,
      users: [],
      queue: [],
      currentClimbQueueItem: null,
      sequence: 0,
      stateHash: 'hash',
      sessionName: null,
    }),
    createDiscoverableSession: vi.fn().mockResolvedValue({}),
    getSessionById: vi.fn().mockResolvedValue(null),
  },
}));

vi.mock('../pubsub/index', () => ({
  pubsub: { publishSessionEvent: vi.fn() },
}));

vi.mock('../../context', () => ({
  updateContext: vi.fn(),
}));

// Provide a stable UUID for predictable assertions
vi.mock('uuid', () => ({
  v4: () => 'test-uuid-1234',
}));

vi.mock('../db/client', () => {
  const database = {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue([]),
    insert: vi.fn().mockReturnThis(),
    values: vi.fn().mockReturnThis(),
    update: vi.fn().mockReturnThis(),
    set: vi.fn().mockReturnThis(),
  };
  return {
    db: {
      ...database,
      transaction: vi.fn((callback: (tx: typeof database) => Promise<unknown>) => callback(database)),
    },
  };
});

vi.mock('./session-summary', () => ({
  generateSessionSummary: vi.fn().mockResolvedValue(null),
}));

function makeAuthenticatedCtx(userId = 'user-1'): ConnectionContext {
  return {
    connectionId: `http-${userId}`,
    transport: 'http',
    sessionId: undefined,
    userId,
    isAuthenticated: true,
  };
}

function makeAnonymousCtx(clientIp?: string): ConnectionContext {
  return {
    connectionId: `http-anonymous-${Math.random()}`,
    transport: 'http',
    sessionId: undefined,
    userId: undefined,
    isAuthenticated: false,
    clientIp,
  };
}

const validNonDiscoverableInput = {
  boardPath: '/kilter/1/2/3/40',
  latitude: 0,
  longitude: 0,
  discoverable: false,
  name: 'Test Session',
};

const validDiscoverableInput = {
  boardPath: '/kilter/1/2/3/40',
  latitude: 37.7749,
  longitude: -122.4194,
  discoverable: true,
  name: 'Discoverable Session',
};

describe('createSession authentication', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each(['public', 'followers', 'invite_only'] as const)(
    'preserves account session audience %s for a legacy explicit Public input during rollback',
    async (defaultSessionAudience) => {
      vi.stubEnv('BOARDSESH_PRIVACY_ENABLED', '0');
      const settingsSpy = vi.spyOn(privacy, 'getPrivacySettings').mockResolvedValue({
        isPrivate: defaultSessionAudience !== 'public',
        defaultSessionAudience,
        privacyRevision: 2,
        privacyOnboardingVersion: 1,
        enabled: false,
      });
      try {
        const result = await sessionMutations.createSession(
          undefined,
          { input: { ...validDiscoverableInput, isPublic: true } },
          makeAuthenticatedCtx(),
        );
        expect(result.isPublic).toBe(defaultSessionAudience === 'public');
      } finally {
        settingsSpy.mockRestore();
        vi.unstubAllEnvs();
      }
    },
  );

  it('allows anonymous users to create non-discoverable sessions', async () => {
    const ctx = makeAnonymousCtx('192.168.1.1');

    const result = await sessionMutations.createSession(undefined, { input: validNonDiscoverableInput }, ctx);

    expect(result.id).toBe('test-uuid-1234');
    expect(result.boardPath).toBe('/kilter/1/2/3/40');
    expect(result.name).toBe('Test Session');
  });

  it('rejects anonymous users from creating discoverable sessions', async () => {
    const ctx = makeAnonymousCtx('192.168.1.1');

    await expect(sessionMutations.createSession(undefined, { input: validDiscoverableInput }, ctx)).rejects.toThrow(
      'Authentication required',
    );
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it('allows authenticated users to create discoverable sessions', async () => {
    const ctx = makeAuthenticatedCtx('user-1');

    const result = await sessionMutations.createSession(undefined, { input: validDiscoverableInput }, ctx);

    expect(result.id).toBe('test-uuid-1234');
    expect(result.boardPath).toBe('/kilter/1/2/3/40');
  });

  it('allows authenticated users to create non-discoverable sessions', async () => {
    const ctx = makeAuthenticatedCtx('user-1');

    const result = await sessionMutations.createSession(undefined, { input: validNonDiscoverableInput }, ctx);

    expect(result.id).toBe('test-uuid-1234');
    expect(result.name).toBe('Test Session');
  });

  it('returns session metadata for HTTP requests without joining in-memory', async () => {
    const ctx = makeAnonymousCtx();

    const result = await sessionMutations.createSession(undefined, { input: validNonDiscoverableInput }, ctx);

    // HTTP requests (connectionId starts with 'http-') don't join in-memory
    expect(result.users).toEqual([]);
    expect(result.queueState).toBeNull();
    expect(result.isLeader).toBe(false);
    // '' rather than null: the schema declares clientId: ID! and the
    // stateless HTTP request has no connection id to report. Matches
    // buildSessionPayload's empty-string fallback convention.
    expect(result.clientId).toBe('');
  });
});
