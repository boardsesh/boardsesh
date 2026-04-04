import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import Redis from 'ioredis';
import { DistributedStateManager, forceResetDistributedState } from '../services/distributed-state';

// Integration tests require Redis to be running
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6380';

// Helper to check if Redis is available
async function isRedisAvailable(): Promise<boolean> {
  const testRedis = new Redis(REDIS_URL, {
    connectTimeout: 1000,
    maxRetriesPerRequest: 0,
    lazyConnect: true,
  });
  try {
    await testRedis.connect();
    await testRedis.ping();
    await testRedis.quit();
    return true;
  } catch {
    try {
      await testRedis.quit();
    } catch {
      // Ignore quit errors
    }
    return false;
  }
}

// Skip all tests if Redis is not available
const redisAvailable = await isRedisAvailable();

describe.skipIf(!redisAvailable)('DistributedStateManager', () => {
  let redis: Redis;
  let manager: DistributedStateManager;

  beforeAll(async () => {
    redis = new Redis(REDIS_URL);
    await new Promise<void>((resolve) => redis.once('ready', resolve));
  });

  afterAll(async () => {
    // Force reset singleton to prevent state pollution between test runs
    forceResetDistributedState();
    await redis.quit();
  });

  beforeEach(async () => {
    // Force reset singleton state before each test to prevent pollution
    forceResetDistributedState();

    // Clean up any existing test keys with try-catch for robustness
    try {
      const keys = await redis.keys('boardsesh:*');
      if (keys.length > 0) {
        await redis.del(...keys);
      }
    } catch (err) {
      console.warn('Failed to clean up test keys:', err);
    }
    manager = new DistributedStateManager(redis, 'test-instance-1');
  });

  afterEach(async () => {
    await manager.stop();
    // Force reset singleton after each test
    forceResetDistributedState();
  });

  describe('Connection Management', () => {
    it('should register a connection', async () => {
      await manager.registerConnection('conn-1', 'TestUser', 'user-123', 'https://avatar.url');

      const connection = await manager.getConnection('conn-1');

      expect(connection).not.toBeNull();
      expect(connection!.connectionId).toBe('conn-1');
      expect(connection!.username).toBe('TestUser');
      expect(connection!.userId).toBe('user-123');
      expect(connection!.avatarUrl).toBe('https://avatar.url');
      expect(connection!.instanceId).toBe('test-instance-1');
      expect(connection!.sessionId).toBeNull();
      expect(connection!.isLeader).toBe(false);
    });

    it('should register a connection without optional fields', async () => {
      await manager.registerConnection('conn-2', 'AnonUser');

      const connection = await manager.getConnection('conn-2');

      expect(connection).not.toBeNull();
      expect(connection!.connectionId).toBe('conn-2');
      expect(connection!.username).toBe('AnonUser');
      expect(connection!.userId).toBeNull();
      expect(connection!.avatarUrl).toBeNull();
    });

    it('should remove a connection', async () => {
      await manager.registerConnection('conn-3', 'User3');

      const result = await manager.removeConnection('conn-3');

      expect(result.sessionId).toBeNull();
      expect(result.wasLeader).toBe(false);

      const connection = await manager.getConnection('conn-3');
      expect(connection).toBeNull();
    });

    it('should handle removing non-existent connection', async () => {
      const result = await manager.removeConnection('non-existent');

      expect(result.sessionId).toBeNull();
      expect(result.wasLeader).toBe(false);
    });

    it('should update username', async () => {
      await manager.registerConnection('conn-4', 'OriginalName');
      await manager.updateUsername('conn-4', 'NewName', 'https://new-avatar.url');

      const connection = await manager.getConnection('conn-4');

      expect(connection!.username).toBe('NewName');
      expect(connection!.avatarUrl).toBe('https://new-avatar.url');
    });
  });

  describe('Session Joining', () => {
    it('should join a session and become leader as first member', async () => {
      await manager.registerConnection('conn-5', 'User5');

      const result = await manager.joinSession('conn-5', 'session-1');

      expect(result.isLeader).toBe(true);

      const connection = await manager.getConnection('conn-5');
      expect(connection!.sessionId).toBe('session-1');
      expect(connection!.isLeader).toBe(true);

      const leader = await manager.getSessionLeader('session-1');
      expect(leader).toBe('conn-5');
    });

    it('should join a session but not become leader if already has one', async () => {
      await manager.registerConnection('conn-6', 'User6');
      await manager.registerConnection('conn-7', 'User7');

      // First user joins and becomes leader
      await manager.joinSession('conn-6', 'session-2');

      // Second user joins, should not become leader
      const result = await manager.joinSession('conn-7', 'session-2');

      expect(result.isLeader).toBe(false);

      const connection = await manager.getConnection('conn-7');
      expect(connection!.sessionId).toBe('session-2');
      expect(connection!.isLeader).toBe(false);

      const leader = await manager.getSessionLeader('session-2');
      expect(leader).toBe('conn-6');
    });

    it('should update username when joining session', async () => {
      await manager.registerConnection('conn-8', 'OriginalName');
      await manager.joinSession('conn-8', 'session-3', 'UpdatedName', 'https://avatar.url');

      const connection = await manager.getConnection('conn-8');
      expect(connection!.username).toBe('UpdatedName');
      expect(connection!.avatarUrl).toBe('https://avatar.url');
    });

    it('should track session membership', async () => {
      await manager.registerConnection('conn-9', 'User9');
      await manager.registerConnection('conn-10', 'User10');

      await manager.joinSession('conn-9', 'session-4');
      await manager.joinSession('conn-10', 'session-4');

      const count = await manager.getSessionMemberCount('session-4');
      expect(count).toBe(2);

      const hasMembers = await manager.hasSessionMembers('session-4');
      expect(hasMembers).toBe(true);
    });
  });

  describe('Session Leaving', () => {
    it('should leave a session', async () => {
      await manager.registerConnection('conn-11', 'User11');
      await manager.joinSession('conn-11', 'session-5');

      const result = await manager.leaveSession('conn-11', 'session-5');

      expect(result.newLeaderId).toBeNull(); // No other members

      const connection = await manager.getConnection('conn-11');
      // After leaving, sessionId is stored as '' in Redis but hashToConnection converts it to null
      expect(connection!.sessionId).toBeNull();
      expect(connection!.isLeader).toBe(false);

      const hasMembers = await manager.hasSessionMembers('session-5');
      expect(hasMembers).toBe(false);
    });

    it('should elect new leader when leader leaves', async () => {
      await manager.registerConnection('conn-12', 'Leader');
      await manager.registerConnection('conn-13', 'Member1');
      await manager.registerConnection('conn-14', 'Member2');

      // Leader joins first
      await manager.joinSession('conn-12', 'session-6');
      // Members join after
      await manager.joinSession('conn-13', 'session-6');
      await manager.joinSession('conn-14', 'session-6');

      // Leader leaves
      const result = await manager.leaveSession('conn-12', 'session-6');

      // New leader should be elected (one of the remaining members)
      expect(result.newLeaderId).not.toBeNull();
      expect(['conn-13', 'conn-14']).toContain(result.newLeaderId);

      // Verify the new leader has isLeader flag
      const newLeaderConn = await manager.getConnection(result.newLeaderId!);
      expect(newLeaderConn!.isLeader).toBe(true);

      // Verify session leader is updated
      const leader = await manager.getSessionLeader('session-6');
      expect(leader).toBe(result.newLeaderId);
    });

    it('should not trigger leader election when non-leader leaves', async () => {
      await manager.registerConnection('conn-15', 'Leader');
      await manager.registerConnection('conn-16', 'Member');

      await manager.joinSession('conn-15', 'session-7');
      await manager.joinSession('conn-16', 'session-7');

      // Non-leader leaves
      const result = await manager.leaveSession('conn-16', 'session-7');

      expect(result.newLeaderId).toBeNull();

      const leader = await manager.getSessionLeader('session-7');
      expect(leader).toBe('conn-15');
    });
  });

  describe('Session Members', () => {
    it('should get all session members', async () => {
      await manager.registerConnection('conn-17', 'User17', 'uid-17');
      await manager.registerConnection('conn-18', 'User18', 'uid-18');
      await manager.registerConnection('conn-19', 'User19', 'uid-19');

      await manager.joinSession('conn-17', 'session-8');
      await manager.joinSession('conn-18', 'session-8');
      await manager.joinSession('conn-19', 'session-8');

      const members = await manager.getSessionMembers('session-8');

      expect(members.length).toBe(3);

      const usernames = members.map((m) => m.username).sort();
      expect(usernames).toEqual(['User17', 'User18', 'User19']);

      // One should be leader
      const leaders = members.filter((m) => m.isLeader);
      expect(leaders.length).toBe(1);
    });

    it('should return empty array for empty session', async () => {
      const members = await manager.getSessionMembers('non-existent-session');
      expect(members).toEqual([]);
    });
  });

  describe('Connection Validation', () => {
    it('should validate connection is in session', async () => {
      await manager.registerConnection('conn-20', 'User20');
      await manager.joinSession('conn-20', 'session-9');

      const isInSession = await manager.isConnectionInSession('conn-20', 'session-9');
      expect(isInSession).toBe(true);

      const isInOtherSession = await manager.isConnectionInSession('conn-20', 'other-session');
      expect(isInOtherSession).toBe(false);
    });

    it('should return false for non-existent connection', async () => {
      const isInSession = await manager.isConnectionInSession('non-existent', 'session-9');
      expect(isInSession).toBe(false);
    });
  });

  describe('Session Cleanup', () => {
    it('should clean up empty session', async () => {
      await manager.registerConnection('conn-21', 'User21');
      await manager.joinSession('conn-21', 'session-10');
      await manager.leaveSession('conn-21', 'session-10');

      await manager.cleanupEmptySession('session-10');

      const hasMembers = await manager.hasSessionMembers('session-10');
      expect(hasMembers).toBe(false);

      const leader = await manager.getSessionLeader('session-10');
      expect(leader).toBeNull();
    });
  });
});

describe.skipIf(!redisAvailable)('DistributedStateManager - Multi-Instance', () => {
  let redis1: Redis;
  let redis2: Redis;
  let manager1: DistributedStateManager;
  let manager2: DistributedStateManager;

  beforeAll(async () => {
    redis1 = new Redis(REDIS_URL);
    redis2 = new Redis(REDIS_URL);
    await Promise.all([
      new Promise<void>((resolve) => redis1.once('ready', resolve)),
      new Promise<void>((resolve) => redis2.once('ready', resolve)),
    ]);
  });

  afterAll(async () => {
    forceResetDistributedState();
    await Promise.all([redis1.quit(), redis2.quit()]);
  });

  beforeEach(async () => {
    forceResetDistributedState();
    // Clean up any existing test keys with try-catch for robustness
    try {
      const keys = await redis1.keys('boardsesh:*');
      if (keys.length > 0) {
        await redis1.del(...keys);
      }
    } catch (err) {
      console.warn('Failed to clean up test keys:', err);
    }
    manager1 = new DistributedStateManager(redis1, 'instance-1');
    manager2 = new DistributedStateManager(redis2, 'instance-2');
  });

  afterEach(async () => {
    await manager1.stop();
    await manager2.stop();
    forceResetDistributedState();
  });

  it('should see connections across instances', async () => {
    // Register connection on instance 1
    await manager1.registerConnection('conn-a', 'UserA');
    // Register connection on instance 2
    await manager2.registerConnection('conn-b', 'UserB');

    // Both should be visible from either instance
    const connA = await manager2.getConnection('conn-a');
    const connB = await manager1.getConnection('conn-b');

    expect(connA).not.toBeNull();
    expect(connA!.instanceId).toBe('instance-1');

    expect(connB).not.toBeNull();
    expect(connB!.instanceId).toBe('instance-2');
  });

  it('should aggregate session members across instances', async () => {
    // Register and join from instance 1
    await manager1.registerConnection('conn-c', 'UserC');
    await manager1.joinSession('conn-c', 'multi-session');

    // Register and join from instance 2
    await manager2.registerConnection('conn-d', 'UserD');
    await manager2.joinSession('conn-d', 'multi-session');

    // Both instances should see all members
    const members1 = await manager1.getSessionMembers('multi-session');
    const members2 = await manager2.getSessionMembers('multi-session');

    expect(members1.length).toBe(2);
    expect(members2.length).toBe(2);

    const usernames = members1.map((m) => m.username).sort();
    expect(usernames).toEqual(['UserC', 'UserD']);
  });

  it('should have consistent leader across instances', async () => {
    // First connection joins from instance 1
    await manager1.registerConnection('conn-e', 'UserE');
    const result1 = await manager1.joinSession('conn-e', 'leader-session');
    expect(result1.isLeader).toBe(true);

    // Second connection joins from instance 2
    await manager2.registerConnection('conn-f', 'UserF');
    const result2 = await manager2.joinSession('conn-f', 'leader-session');
    expect(result2.isLeader).toBe(false);

    // Both instances should agree on leader
    const leader1 = await manager1.getSessionLeader('leader-session');
    const leader2 = await manager2.getSessionLeader('leader-session');

    expect(leader1).toBe('conn-e');
    expect(leader2).toBe('conn-e');
  });

  it('should handle leader leaving from different instance', async () => {
    // Leader joins from instance 1
    await manager1.registerConnection('conn-g', 'Leader');
    await manager1.joinSession('conn-g', 'transfer-session');

    // Member joins from instance 2
    await manager2.registerConnection('conn-h', 'Member');
    await manager2.joinSession('conn-h', 'transfer-session');

    // Leader leaves (from instance 1)
    const result = await manager1.leaveSession('conn-g', 'transfer-session');

    // New leader should be elected
    expect(result.newLeaderId).toBe('conn-h');

    // Both instances should see the new leader
    const leader1 = await manager1.getSessionLeader('transfer-session');
    const leader2 = await manager2.getSessionLeader('transfer-session');

    expect(leader1).toBe('conn-h');
    expect(leader2).toBe('conn-h');
  });

  it('should handle concurrent joins correctly', async () => {
    // Register connections
    await Promise.all([
      manager1.registerConnection('conn-i', 'UserI'),
      manager2.registerConnection('conn-j', 'UserJ'),
    ]);

    // Join concurrently
    const [result1, result2] = await Promise.all([
      manager1.joinSession('conn-i', 'concurrent-session'),
      manager2.joinSession('conn-j', 'concurrent-session'),
    ]);

    // Exactly one should be leader
    expect(result1.isLeader !== result2.isLeader).toBe(true);

    // Session should have exactly one leader
    const members = await manager1.getSessionMembers('concurrent-session');
    const leaders = members.filter((m) => m.isLeader);
    expect(leaders.length).toBe(1);
  });

  it('should handle concurrent leader and member departures correctly', async () => {
    const sessionId = 'concurrent-leave-session-' + Date.now();

    // Setup: 3 members, conn-a is leader (earliest connected)
    await manager1.registerConnection('conn-concurrent-a', 'Leader');
    await manager1.joinSession('conn-concurrent-a', sessionId);

    // Small delay to ensure conn-a is earliest
    await new Promise((r) => setTimeout(r, 20));

    await manager2.registerConnection('conn-concurrent-b', 'Member1');
    await manager2.joinSession('conn-concurrent-b', sessionId);

    await new Promise((r) => setTimeout(r, 20));

    await manager1.registerConnection('conn-concurrent-c', 'Member2');
    await manager1.joinSession('conn-concurrent-c', sessionId);

    // Verify initial state
    const initialLeader = await manager1.getSessionLeader(sessionId);
    expect(initialLeader).toBe('conn-concurrent-a');

    const initialMembers = await manager1.getSessionMembers(sessionId);
    expect(initialMembers.length).toBe(3);

    // Concurrent leaves: leader + one member
    const [result1, result2] = await Promise.all([
      manager1.leaveSession('conn-concurrent-a', sessionId),
      manager2.leaveSession('conn-concurrent-b', sessionId),
    ]);

    // Small delay to allow Redis state to settle
    await new Promise((r) => setTimeout(r, 50));

    // Verify session state after concurrent departures
    const members = await manager1.getSessionMembers(sessionId);
    const leader = await manager1.getSessionLeader(sessionId);

    // At least one leader election should have succeeded
    expect(result1.newLeaderId || result2.newLeaderId).toBeTruthy();

    // The remaining member should be conn-concurrent-c
    expect(members.length).toBe(1);

    // Verify conn-concurrent-c is the remaining member (SessionUser uses `id` field)
    const remainingMember = members.find((m) => m.id === 'conn-concurrent-c');
    expect(remainingMember).toBeDefined();
    expect(remainingMember?.isLeader).toBe(true);

    // Verify leader key is correctly set
    expect(leader).toBe('conn-concurrent-c');
  });

  it('should clean up connections when instance stops', async () => {
    // Register connection on instance 1
    await manager1.registerConnection('conn-k', 'UserK');
    await manager1.joinSession('conn-k', 'cleanup-session');

    // Register connection on instance 2
    await manager2.registerConnection('conn-l', 'UserL');
    await manager2.joinSession('conn-l', 'cleanup-session');

    // Verify both are members
    expect(await manager1.getSessionMemberCount('cleanup-session')).toBe(2);

    // Instance 1 stops (simulating crash/restart)
    await manager1.stop();

    // Give a moment for cleanup
    await new Promise((r) => setTimeout(r, 100));

    // Only instance 2's connection should remain
    const members = await manager2.getSessionMembers('cleanup-session');
    expect(members.length).toBe(1);
    expect(members[0].username).toBe('UserL');

    // UserL should now be leader
    const leader = await manager2.getSessionLeader('cleanup-session');
    expect(leader).toBe('conn-l');
  });
});

describe.skipIf(!redisAvailable)('DistributedStateManager - Edge Cases', () => {
  let redis: Redis;
  let manager: DistributedStateManager;

  beforeAll(async () => {
    redis = new Redis(REDIS_URL);
    await new Promise<void>((resolve) => redis.once('ready', resolve));
  });

  afterAll(async () => {
    forceResetDistributedState();
    await redis.quit();
  });

  beforeEach(async () => {
    forceResetDistributedState();
    // Clean up any existing test keys with try-catch for robustness
    try {
      const keys = await redis.keys('boardsesh:*');
      if (keys.length > 0) {
        await redis.del(...keys);
      }
    } catch (err) {
      console.warn('Failed to clean up test keys:', err);
    }
    manager = new DistributedStateManager(redis, 'edge-instance');
  });

  afterEach(async () => {
    await manager.stop();
    forceResetDistributedState();
  });

  it('should handle rapid join/leave cycles', async () => {
    await manager.registerConnection('rapid-conn', 'RapidUser');

    for (let i = 0; i < 10; i++) {
      await manager.joinSession('rapid-conn', `rapid-session-${i}`);
      await manager.leaveSession('rapid-conn', `rapid-session-${i}`);
    }

    const connection = await manager.getConnection('rapid-conn');
    // After leaving, sessionId is stored as '' in Redis but hashToConnection converts it to null
    expect(connection!.sessionId).toBeNull();
    expect(connection!.isLeader).toBe(false);
  });

  it('should handle joining multiple sessions (leaving previous)', async () => {
    await manager.registerConnection('multi-session-conn', 'MultiUser');

    await manager.joinSession('multi-session-conn', 'first-session');
    expect(await manager.isConnectionInSession('multi-session-conn', 'first-session')).toBe(true);

    // Note: The current implementation doesn't auto-leave previous session
    // That logic would be in RoomManager - here we test the distributed state layer
    await manager.leaveSession('multi-session-conn', 'first-session');
    await manager.joinSession('multi-session-conn', 'second-session');

    expect(await manager.isConnectionInSession('multi-session-conn', 'second-session')).toBe(true);
    expect(await manager.isConnectionInSession('multi-session-conn', 'first-session')).toBe(false);
  });

  it('should handle empty username', async () => {
    await manager.registerConnection('empty-name-conn', '');

    const connection = await manager.getConnection('empty-name-conn');
    expect(connection!.username).toBe('');
  });

  it('should return unique instance IDs', async () => {
    const manager2 = new DistributedStateManager(redis);
    const manager3 = new DistributedStateManager(redis);

    expect(manager.getInstanceId()).toBe('edge-instance');
    expect(manager2.getInstanceId()).not.toBe(manager.getInstanceId());
    expect(manager3.getInstanceId()).not.toBe(manager2.getInstanceId());

    // Clean up managers to prevent memory leaks
    await manager2.stop();
    await manager3.stop();
  });

  it('should handle getSessionMembers with stale connection data', async () => {
    await manager.registerConnection('stale-conn', 'StaleUser');
    await manager.joinSession('stale-conn', 'stale-session');

    // Manually remove connection data but keep session membership
    // (simulating data inconsistency)
    await redis.del('boardsesh:conn:stale-conn');

    // getSessionMembers should handle missing connection gracefully
    const members = await manager.getSessionMembers('stale-session');
    // The stale member should be filtered out
    expect(members.length).toBe(0);
  });

  it('should handle leader election when all members leave', async () => {
    await manager.registerConnection('solo-conn', 'SoloUser');
    await manager.joinSession('solo-conn', 'solo-session');

    const result = await manager.leaveSession('solo-conn', 'solo-session');

    // No new leader since no one left
    expect(result.newLeaderId).toBeNull();

    // Session should have no leader
    const leader = await manager.getSessionLeader('solo-session');
    expect(leader).toBeNull();
  });
});

describe.skipIf(!redisAvailable)('DistributedStateManager - removeConnection with leader election', () => {
  let redis: Redis;
  let manager: DistributedStateManager;

  beforeAll(async () => {
    redis = new Redis(REDIS_URL);
    await new Promise<void>((resolve) => redis.once('ready', resolve));
  });

  afterAll(async () => {
    forceResetDistributedState();
    await redis.quit();
  });

  beforeEach(async () => {
    forceResetDistributedState();
    try {
      const keys = await redis.keys('boardsesh:*');
      if (keys.length > 0) {
        await redis.del(...keys);
      }
    } catch (err) {
      console.warn('Failed to clean up test keys:', err);
    }
    manager = new DistributedStateManager(redis, 'remove-test-instance');
  });

  afterEach(async () => {
    await manager.stop();
    forceResetDistributedState();
  });

  it('should automatically elect new leader when removing leader connection', async () => {
    await manager.registerConnection('leader-conn', 'Leader');
    await manager.registerConnection('member-conn', 'Member');

    await manager.joinSession('leader-conn', 'auto-elect-session');
    await manager.joinSession('member-conn', 'auto-elect-session');

    // Verify leader-conn is leader
    const initialLeader = await manager.getSessionLeader('auto-elect-session');
    expect(initialLeader).toBe('leader-conn');

    // Remove leader using removeConnection (should auto-elect)
    const result = await manager.removeConnection('leader-conn');

    expect(result.sessionId).toBe('auto-elect-session');
    expect(result.wasLeader).toBe(true);
    expect(result.newLeaderId).toBe('member-conn');

    // Verify new leader is set
    const newLeader = await manager.getSessionLeader('auto-elect-session');
    expect(newLeader).toBe('member-conn');

    // Verify new leader has isLeader flag
    const memberConn = await manager.getConnection('member-conn');
    expect(memberConn!.isLeader).toBe(true);
  });

  it('should skip leader election when electNewLeader is false', async () => {
    await manager.registerConnection('leader-conn', 'Leader');
    await manager.registerConnection('member-conn', 'Member');

    await manager.joinSession('leader-conn', 'skip-elect-session');
    await manager.joinSession('member-conn', 'skip-elect-session');

    // Remove leader but skip auto-election
    const result = await manager.removeConnection('leader-conn', false);

    expect(result.wasLeader).toBe(true);
    expect(result.newLeaderId).toBeNull(); // No election happened

    // Leader key still points to removed connection (stale)
    const leaderKey = await manager.getSessionLeader('skip-elect-session');
    expect(leaderKey).toBe('leader-conn');
  });

  it('should return newLeaderId as null when removing non-leader', async () => {
    await manager.registerConnection('leader-conn', 'Leader');
    await manager.registerConnection('member-conn', 'Member');

    await manager.joinSession('leader-conn', 'non-leader-session');
    await manager.joinSession('member-conn', 'non-leader-session');

    // Remove member (not leader)
    const result = await manager.removeConnection('member-conn');

    expect(result.wasLeader).toBe(false);
    expect(result.newLeaderId).toBeNull();

    // Leader should still be leader-conn
    const leader = await manager.getSessionLeader('non-leader-session');
    expect(leader).toBe('leader-conn');
  });
});

describe.skipIf(!redisAvailable)('DistributedStateManager - refreshConnection', () => {
  let redis: Redis;
  let manager: DistributedStateManager;

  beforeAll(async () => {
    redis = new Redis(REDIS_URL);
    await new Promise<void>((resolve) => redis.once('ready', resolve));
  });

  afterAll(async () => {
    forceResetDistributedState();
    await redis.quit();
  });

  beforeEach(async () => {
    forceResetDistributedState();
    try {
      const keys = await redis.keys('boardsesh:*');
      if (keys.length > 0) {
        await redis.del(...keys);
      }
    } catch (err) {
      console.warn('Failed to clean up test keys:', err);
    }
    manager = new DistributedStateManager(redis, 'refresh-test-instance');
  });

  afterEach(async () => {
    await manager.stop();
    forceResetDistributedState();
  });

  it('should return true when refreshing existing connection', async () => {
    await manager.registerConnection('refresh-conn', 'RefreshUser');

    const result = await manager.refreshConnection('refresh-conn');
    expect(result).toBe(true);
  });

  it('should return false when refreshing non-existent connection', async () => {
    const result = await manager.refreshConnection('non-existent-conn');
    expect(result).toBe(false);
  });

  it('should refresh session membership TTL when connection is in session', async () => {
    await manager.registerConnection('session-refresh-conn', 'SessionUser');
    await manager.joinSession('session-refresh-conn', 'refresh-session');

    // Get initial TTL (should be around 4 hours = 14400 seconds)
    const initialTTL = await redis.ttl('boardsesh:session:refresh-session:members');
    expect(initialTTL).toBeGreaterThan(14000);

    // Wait a tiny bit and refresh
    await new Promise((r) => setTimeout(r, 100));
    await manager.refreshConnection('session-refresh-conn');

    // TTL should still be high (refreshed)
    const afterTTL = await redis.ttl('boardsesh:session:refresh-session:members');
    expect(afterTTL).toBeGreaterThan(14000);
  });
});

describe.skipIf(!redisAvailable)('DistributedStateManager - old leader flag reset', () => {
  let redis: Redis;
  let manager: DistributedStateManager;

  beforeAll(async () => {
    redis = new Redis(REDIS_URL);
    await new Promise<void>((resolve) => redis.once('ready', resolve));
  });

  afterAll(async () => {
    forceResetDistributedState();
    await redis.quit();
  });

  beforeEach(async () => {
    forceResetDistributedState();
    try {
      const keys = await redis.keys('boardsesh:*');
      if (keys.length > 0) {
        await redis.del(...keys);
      }
    } catch (err) {
      console.warn('Failed to clean up test keys:', err);
    }
    manager = new DistributedStateManager(redis, 'flag-reset-instance');
  });

  afterEach(async () => {
    await manager.stop();
    forceResetDistributedState();
  });

  it('should reset old leader isLeader flag when electing new leader', async () => {
    await manager.registerConnection('old-leader', 'OldLeader');
    await manager.registerConnection('new-leader', 'NewLeader');

    await manager.joinSession('old-leader', 'flag-reset-session');
    await manager.joinSession('new-leader', 'flag-reset-session');

    // Verify old-leader is leader with isLeader=true
    const oldLeaderBefore = await manager.getConnection('old-leader');
    expect(oldLeaderBefore!.isLeader).toBe(true);

    // Old leader leaves, new leader should be elected
    await manager.leaveSession('old-leader', 'flag-reset-session');

    // Verify old leader's isLeader flag is now false
    const oldLeaderAfter = await manager.getConnection('old-leader');
    expect(oldLeaderAfter!.isLeader).toBe(false);

    // Verify new leader has isLeader=true
    const newLeaderAfter = await manager.getConnection('new-leader');
    expect(newLeaderAfter!.isLeader).toBe(true);
  });
});

describe.skipIf(!redisAvailable)('DistributedStateManager - start() idempotency', () => {
  let redis: Redis;
  let manager: DistributedStateManager;

  beforeAll(async () => {
    redis = new Redis(REDIS_URL);
    await new Promise<void>((resolve) => redis.once('ready', resolve));
  });

  afterAll(async () => {
    forceResetDistributedState();
    await redis.quit();
  });

  beforeEach(async () => {
    forceResetDistributedState();
    try {
      const keys = await redis.keys('boardsesh:*');
      if (keys.length > 0) {
        await redis.del(...keys);
      }
    } catch (err) {
      console.warn('Failed to clean up test keys:', err);
    }
    manager = new DistributedStateManager(redis, 'idempotent-instance');
  });

  afterEach(async () => {
    await manager.stop();
    forceResetDistributedState();
  });

  it('should be idempotent - multiple start calls should not create multiple intervals', async () => {
    // Register a connection so cleanup will run fully (including heartbeat key deletion)
    await manager.registerConnection('idempotent-conn', 'IdempotentUser');

    // Call start multiple times
    manager.start();
    manager.start();
    manager.start();

    // Give heartbeat time to run
    await new Promise((r) => setTimeout(r, 100));

    // Verify heartbeat was created (instance heartbeat key exists)
    const heartbeatKey = `boardsesh:instance:${manager.getInstanceId()}:heartbeat`;
    const heartbeatValue = await redis.get(heartbeatKey);
    expect(heartbeatValue).toBeTruthy();

    // Stop should succeed without issues (would throw if multiple intervals)
    await manager.stop();
    expect(manager.isStopped()).toBe(true);

    // Heartbeat should be cleared (cleanup runs because we have a connection)
    const heartbeatAfterStop = await redis.get(heartbeatKey);
    expect(heartbeatAfterStop).toBeNull();
  });
});

describe.skipIf(!redisAvailable)('DistributedStateManager - Redis error handling', () => {
  let redis: Redis;

  beforeAll(async () => {
    redis = new Redis(REDIS_URL);
    await new Promise<void>((resolve) => redis.once('ready', resolve));
  });

  afterAll(async () => {
    forceResetDistributedState();
    await redis.quit();
  });

  beforeEach(async () => {
    forceResetDistributedState();
    try {
      const keys = await redis.keys('boardsesh:*');
      if (keys.length > 0) {
        await redis.del(...keys);
      }
    } catch (err) {
      console.warn('Failed to clean up test keys:', err);
    }
  });

  afterEach(() => {
    forceResetDistributedState();
  });

  it('should throw error for invalid connectionId format', async () => {
    const manager = new DistributedStateManager(redis, 'validation-test');

    // Invalid characters in connectionId
    await expect(manager.getConnection('conn:with:colons')).rejects.toThrow('Invalid connectionId format');
    await expect(manager.getConnection('../path/traversal')).rejects.toThrow('Invalid connectionId format');
    await expect(manager.getConnection('')).rejects.toThrow('Invalid connectionId format');

    await manager.stop();
  });

  it('should throw error for invalid sessionId format', async () => {
    const manager = new DistributedStateManager(redis, 'validation-test');
    await manager.registerConnection('valid-conn', 'TestUser');

    // Invalid characters in sessionId
    await expect(manager.joinSession('valid-conn', 'session:with:colons')).rejects.toThrow(
      'Invalid sessionId format'
    );
    await expect(manager.getSessionMembers('../path/traversal')).rejects.toThrow('Invalid sessionId format');
    await expect(manager.getSessionLeader('')).rejects.toThrow('Invalid sessionId format');

    await manager.stop();
  });

  it('should handle disconnected Redis gracefully in getConnection', async () => {
    const disconnectedRedis = new Redis({
      host: 'localhost',
      port: 9999, // Non-existent port
      connectTimeout: 100,
      maxRetriesPerRequest: 0,
      lazyConnect: true,
    });

    const errorManager = new DistributedStateManager(disconnectedRedis, 'error-test');

    // Should reject with connection error
    await expect(errorManager.getConnection('test-id')).rejects.toThrow();

    // Clean up
    errorManager.stopHeartbeat();
    try {
      await disconnectedRedis.quit();
    } catch {
      // Ignore quit errors on disconnected redis
    }
  });

  it('should handle disconnected Redis gracefully in registerConnection', async () => {
    const disconnectedRedis = new Redis({
      host: 'localhost',
      port: 9999, // Non-existent port
      connectTimeout: 100,
      maxRetriesPerRequest: 0,
      lazyConnect: true,
    });

    const errorManager = new DistributedStateManager(disconnectedRedis, 'error-test');

    // Should reject with connection error
    await expect(errorManager.registerConnection('test-id', 'TestUser')).rejects.toThrow();

    // Clean up
    errorManager.stopHeartbeat();
    try {
      await disconnectedRedis.quit();
    } catch {
      // Ignore quit errors on disconnected redis
    }
  });
});

describe.skipIf(!redisAvailable)('DistributedStateManager - cleanup error handling', () => {
  let redis: Redis;
  let manager: DistributedStateManager;

  beforeAll(async () => {
    redis = new Redis(REDIS_URL);
    await new Promise<void>((resolve) => redis.once('ready', resolve));
  });

  afterAll(async () => {
    forceResetDistributedState();
    await redis.quit();
  });

  beforeEach(async () => {
    forceResetDistributedState();
    try {
      const keys = await redis.keys('boardsesh:*');
      if (keys.length > 0) {
        await redis.del(...keys);
      }
    } catch (err) {
      console.warn('Failed to clean up test keys:', err);
    }
    manager = new DistributedStateManager(redis, 'cleanup-test');
  });

  afterEach(async () => {
    await manager.stop();
    forceResetDistributedState();
  });

  it('should complete cleanup even when some connections are already removed', async () => {
    // Register multiple connections
    await manager.registerConnection('cleanup-conn-1', 'User1');
    await manager.registerConnection('cleanup-conn-2', 'User2');
    await manager.registerConnection('cleanup-conn-3', 'User3');

    // Manually delete one connection to simulate it being removed by another process
    await redis.del('boardsesh:conn:cleanup-conn-2');

    // Stop should complete successfully, handling the missing connection gracefully
    await manager.stop();
    expect(manager.isStopped()).toBe(true);

    // Verify all connections are cleaned up
    const conn1 = await redis.hgetall('boardsesh:conn:cleanup-conn-1');
    const conn2 = await redis.hgetall('boardsesh:conn:cleanup-conn-2');
    const conn3 = await redis.hgetall('boardsesh:conn:cleanup-conn-3');

    expect(Object.keys(conn1).length).toBe(0);
    expect(Object.keys(conn2).length).toBe(0);
    expect(Object.keys(conn3).length).toBe(0);
  });

  it('should handle cleanup when instance tracking is corrupted', async () => {
    // Register a connection
    await manager.registerConnection('corrupt-conn', 'CorruptUser');

    // Corrupt the instance tracking by adding a non-existent connection
    await redis.sadd(`boardsesh:instance:${manager.getInstanceId()}:conns`, 'non-existent-conn');

    // Stop should complete successfully, handling the non-existent connection gracefully
    await manager.stop();
    expect(manager.isStopped()).toBe(true);

    // Verify the real connection is cleaned up
    const conn = await redis.hgetall('boardsesh:conn:corrupt-conn');
    expect(Object.keys(conn).length).toBe(0);
  });
});

describe.skipIf(!redisAvailable)('DistributedStateManager - Dead Instance Cleanup', () => {
  let redis: Redis;
  let liveManager: DistributedStateManager;

  beforeAll(async () => {
    redis = new Redis(REDIS_URL);
    await new Promise<void>((resolve) => redis.once('ready', resolve));
  });

  afterAll(async () => {
    forceResetDistributedState();
    await redis.quit();
  });

  beforeEach(async () => {
    forceResetDistributedState();
    try {
      const keys = await redis.keys('boardsesh:*');
      if (keys.length > 0) {
        await redis.del(...keys);
      }
    } catch (err) {
      console.warn('Failed to clean up test keys:', err);
    }
    liveManager = new DistributedStateManager(redis, 'live-instance');
  });

  afterEach(async () => {
    await liveManager.stop();
    forceResetDistributedState();
  });

  describe('discoverDeadInstances', () => {
    it('should return empty when no other instances exist', async () => {
      liveManager.start();
      // Give heartbeat time to run
      await new Promise((r) => setTimeout(r, 100));

      const dead = await liveManager.discoverDeadInstances();
      expect(dead).toEqual([]);
    });

    it('should skip the current instance', async () => {
      liveManager.start();
      await new Promise((r) => setTimeout(r, 100));

      // Even if we manually clear our own heartbeat, discoverDeadInstances
      // skips the current instance ID.
      await redis.del('boardsesh:instance:live-instance:heartbeat');

      const dead = await liveManager.discoverDeadInstances();
      expect(dead).toEqual([]);
    });

    it('should find instances whose heartbeat expired', async () => {
      // Simulate a dead instance: create its conns key but no heartbeat
      await redis.sadd('boardsesh:instance:dead-inst:conns', 'orphan-conn-1');

      const dead = await liveManager.discoverDeadInstances();
      expect(dead).toEqual(['dead-inst']);
    });

    it('should not report instances with active heartbeats', async () => {
      // Create another instance with a valid heartbeat
      await redis.sadd('boardsesh:instance:alive-inst:conns', 'conn-x');
      await redis.setex('boardsesh:instance:alive-inst:heartbeat', 60, Date.now().toString());

      const dead = await liveManager.discoverDeadInstances();
      expect(dead).toEqual([]);
    });
  });

  describe('cleanupDeadInstanceConnections', () => {
    it('should remove orphaned connections from dead instances', async () => {
      // Register a live connection
      await liveManager.registerConnection('live-conn', 'LiveUser');
      await liveManager.joinSession('live-conn', 'shared-session');

      // Simulate a dead instance with orphaned connections in the same session
      const deadInstanceId = 'dead-instance-abc';
      // Create connection hashes for the dead connections
      await redis.hmset('boardsesh:conn:orphan-1', {
        connectionId: 'orphan-1',
        instanceId: deadInstanceId,
        sessionId: 'shared-session',
        userId: '',
        username: 'Ghost1',
        avatarUrl: '',
        isLeader: 'false',
        connectedAt: (Date.now() - 60000).toString(),
      });
      await redis.hmset('boardsesh:conn:orphan-2', {
        connectionId: 'orphan-2',
        instanceId: deadInstanceId,
        sessionId: 'shared-session',
        userId: '',
        username: 'Ghost2',
        avatarUrl: '',
        isLeader: 'false',
        connectedAt: (Date.now() - 60000).toString(),
      });
      // Add to instance tracking (no heartbeat = dead)
      await redis.sadd(`boardsesh:instance:${deadInstanceId}:conns`, 'orphan-1', 'orphan-2');
      // Add to session members
      await redis.sadd('boardsesh:session:shared-session:members', 'orphan-1', 'orphan-2');

      // Verify inflated count before cleanup
      const rawCount = await redis.scard('boardsesh:session:shared-session:members');
      expect(rawCount).toBe(3); // 1 live + 2 ghosts

      // Run cleanup
      const result = await liveManager.cleanupDeadInstanceConnections();

      expect(result.deadInstances).toEqual([deadInstanceId]);
      expect(result.staleConnections.sort()).toEqual(['orphan-1', 'orphan-2']);
      expect(result.sessionsAffected).toEqual(['shared-session']);

      // Verify connection hashes are deleted
      const conn1 = await redis.hgetall('boardsesh:conn:orphan-1');
      const conn2 = await redis.hgetall('boardsesh:conn:orphan-2');
      expect(Object.keys(conn1).length).toBe(0);
      expect(Object.keys(conn2).length).toBe(0);

      // Verify instance tracking key is deleted
      const instanceConns = await redis.smembers(`boardsesh:instance:${deadInstanceId}:conns`);
      expect(instanceConns.length).toBe(0);

      // Verify session member count is correct (only live connection)
      const members = await liveManager.getSessionMembers('shared-session');
      expect(members.length).toBe(1);
      expect(members[0].username).toBe('LiveUser');
    });

    it('should return empty summary when no dead instances exist', async () => {
      const result = await liveManager.cleanupDeadInstanceConnections();
      expect(result.deadInstances).toEqual([]);
      expect(result.staleConnections).toEqual([]);
      expect(result.sessionsAffected).toEqual([]);
    });

    it('should handle dead instance with no connections', async () => {
      // Dead instance with empty conns set
      await redis.sadd('boardsesh:instance:empty-dead:conns', '__placeholder__');
      await redis.srem('boardsesh:instance:empty-dead:conns', '__placeholder__');
      // Actually just create the key with an entry then remove it—
      // simpler: just create it directly
      await redis.del('boardsesh:instance:empty-dead:conns');
      // Need the key to exist for SCAN to find it
      await redis.sadd('boardsesh:instance:empty-dead:conns', 'temp');
      await redis.srem('boardsesh:instance:empty-dead:conns', 'temp');

      // The key may or may not exist (Redis deletes empty sets).
      // Either way, cleanup should not error.
      const result = await liveManager.cleanupDeadInstanceConnections();
      // May or may not find the instance depending on whether Redis kept the empty set
      expect(result.staleConnections).toEqual([]);
    });
  });

  describe('cleanupStaleSessionMembers', () => {
    it('should remove members whose connection hashes expired', async () => {
      await liveManager.registerConnection('real-conn', 'RealUser');
      await liveManager.joinSession('real-conn', 'prune-session');

      // Add a stale member directly (no connection hash)
      await redis.sadd('boardsesh:session:prune-session:members', 'stale-conn');

      // Verify stale member is in the set
      const rawCount = await redis.scard('boardsesh:session:prune-session:members');
      expect(rawCount).toBe(2);

      const removed = await liveManager.cleanupStaleSessionMembers('prune-session');
      expect(removed).toBe(1);

      // Only real connection remains
      const count = await liveManager.getSessionMemberCount('prune-session');
      expect(count).toBe(1);
    });

    it('should re-elect leader when stale leader is pruned', async () => {
      await liveManager.registerConnection('member-conn', 'Member');
      await liveManager.joinSession('member-conn', 'leader-prune-session');

      // Add a stale leader directly
      await redis.sadd('boardsesh:session:leader-prune-session:members', 'stale-leader');
      await redis.set('boardsesh:session:leader-prune-session:leader', 'stale-leader', 'EX', 14400);

      const removed = await liveManager.cleanupStaleSessionMembers('leader-prune-session');
      expect(removed).toBe(1);

      // member-conn should now be leader
      const leader = await liveManager.getSessionLeader('leader-prune-session');
      expect(leader).toBe('member-conn');

      const conn = await liveManager.getConnection('member-conn');
      expect(conn!.isLeader).toBe(true);
    });

    it('should clean up empty session when all members are stale', async () => {
      // Add only stale members
      await redis.sadd('boardsesh:session:all-stale:members', 'gone-1', 'gone-2');
      await redis.set('boardsesh:session:all-stale:leader', 'gone-1', 'EX', 14400);

      const removed = await liveManager.cleanupStaleSessionMembers('all-stale');
      expect(removed).toBe(2);

      // Session should be cleaned up
      const exists = await redis.exists('boardsesh:session:all-stale:members');
      expect(exists).toBe(0);

      const leader = await liveManager.getSessionLeader('all-stale');
      expect(leader).toBeNull();
    });

    it('should return 0 when no stale members exist', async () => {
      await liveManager.registerConnection('healthy-conn', 'Healthy');
      await liveManager.joinSession('healthy-conn', 'healthy-session');

      const removed = await liveManager.cleanupStaleSessionMembers('healthy-session');
      expect(removed).toBe(0);
    });
  });

  describe('getSessionMemberCount - stale filtering', () => {
    it('should not count members whose connection hashes are missing', async () => {
      await liveManager.registerConnection('counted-conn', 'Counted');
      await liveManager.joinSession('counted-conn', 'count-session');

      // Add stale members directly to the session set
      await redis.sadd('boardsesh:session:count-session:members', 'ghost-1', 'ghost-2');

      // Raw SCARD would return 3, but getSessionMemberCount should return 1
      const rawCount = await redis.scard('boardsesh:session:count-session:members');
      expect(rawCount).toBe(3);

      const filteredCount = await liveManager.getSessionMemberCount('count-session');
      expect(filteredCount).toBe(1);
    });

    it('should return 0 for empty session', async () => {
      const count = await liveManager.getSessionMemberCount('nonexistent-session');
      expect(count).toBe(0);
    });
  });

  describe('getSessionMembers - self-healing cleanup', () => {
    it('should remove stale member IDs from the session set on read', async () => {
      await liveManager.registerConnection('live-conn-sh', 'LiveUser');
      await liveManager.joinSession('live-conn-sh', 'self-heal-session');

      // Add stale members directly (no connection hash)
      await redis.sadd('boardsesh:session:self-heal-session:members', 'ghost-a', 'ghost-b');

      // Raw set has 3 members
      const rawBefore = await redis.scard('boardsesh:session:self-heal-session:members');
      expect(rawBefore).toBe(3);

      // getSessionMembers returns only the live one
      const members = await liveManager.getSessionMembers('self-heal-session');
      expect(members.length).toBe(1);
      expect(members[0].username).toBe('LiveUser');

      // Wait briefly for fire-and-forget cleanup to complete
      await new Promise((resolve) => setTimeout(resolve, 100));

      // The stale IDs should now be removed from the Redis set
      const rawAfter = await redis.scard('boardsesh:session:self-heal-session:members');
      expect(rawAfter).toBe(1);
    });

    it('should not remove anything when all members are live', async () => {
      await liveManager.registerConnection('ok-conn-1', 'User1');
      await liveManager.registerConnection('ok-conn-2', 'User2');
      await liveManager.joinSession('ok-conn-1', 'healthy-session-sh');
      await liveManager.joinSession('ok-conn-2', 'healthy-session-sh');

      const members = await liveManager.getSessionMembers('healthy-session-sh');
      expect(members.length).toBe(2);

      // Wait briefly for any fire-and-forget to run
      await new Promise((resolve) => setTimeout(resolve, 50));

      const rawCount = await redis.scard('boardsesh:session:healthy-session-sh:members');
      expect(rawCount).toBe(2);
    });
  });
});
