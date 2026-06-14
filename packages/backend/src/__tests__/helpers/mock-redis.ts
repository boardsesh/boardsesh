import { vi } from 'vite-plus/test';
import type Redis from 'ioredis';

export type MockRedis = Redis & {
  _store: Map<string, string>;
  _hashes: Map<string, Record<string, string>>;
};

/**
 * Sentinel value matching UNSET_SENTINEL in distributed-state.ts.
 * Used in JOIN_SESSION_SCRIPT Lua to mean "don't update this field".
 */
const UNSET_SENTINEL = '__UNSET__';

/**
 * Create a mock Redis instance for testing.
 *
 * Supports the subset of Redis commands used by RedisSessionStore and
 * DistributedStateManager: strings, hashes, sets, sorted sets, multi/pipeline,
 * and Lua eval scripts for distributed lock / leader election.
 */
export const createMockRedis = (): MockRedis => {
  const store = new Map<string, string>();
  const sets = new Map<string, Set<string>>();
  const hashes = new Map<string, Record<string, string>>();
  const sortedSets = new Map<string, Array<{ score: number; member: string }>>();

  const mockRedis = {
    set: vi.fn(async (key: string, value: string, ...opts: unknown[]) => {
      // Support NX flag (only set if key doesn't exist) used by acquireLock
      const hasNX = opts.some((o) => typeof o === 'string' && o.toUpperCase() === 'NX');
      if (hasNX && store.has(key)) {
        return null; // Key exists, NX prevents overwrite
      }
      store.set(key, value);
      return 'OK';
    }),
    get: vi.fn(async (key: string) => {
      return store.get(key) || null;
    }),
    del: vi.fn(async (...keys: string[]) => {
      let count = 0;
      for (const key of keys) {
        if (store.delete(key)) count++;
        if (sets.delete(key)) count++;
        if (hashes.delete(key)) count++;
        if (sortedSets.delete(key)) count++;
      }
      return count;
    }),
    exists: vi.fn(async (key: string) => {
      return store.has(key) || hashes.has(key) ? 1 : 0;
    }),
    expire: vi.fn(async () => 1),
    hmset: vi.fn(async (key: string, obj: Record<string, string>) => {
      hashes.set(key, { ...hashes.get(key), ...obj });
      return 'OK';
    }),
    hgetall: vi.fn(async (key: string) => {
      return hashes.get(key) || {};
    }),
    sadd: vi.fn(async (key: string, ...members: string[]) => {
      if (!sets.has(key)) sets.set(key, new Set());
      const set = sets.get(key)!;
      let count = 0;
      for (const member of members) {
        if (!set.has(member)) {
          set.add(member);
          count++;
        }
      }
      return count;
    }),
    srem: vi.fn(async (key: string, ...members: string[]) => {
      const set = sets.get(key);
      if (!set) return 0;
      let count = 0;
      for (const member of members) {
        if (set.delete(member)) count++;
      }
      return count;
    }),
    zadd: vi.fn(async (key: string, score: number, member: string) => {
      if (!sortedSets.has(key)) sortedSets.set(key, []);
      const zset = sortedSets.get(key)!;
      const existing = zset.findIndex((item) => item.member === member);
      if (existing >= 0) {
        zset[existing].score = score;
        return 0;
      } else {
        zset.push({ score, member });
        return 1;
      }
    }),
    zrem: vi.fn(async (key: string, member: string) => {
      const zset = sortedSets.get(key);
      if (!zset) return 0;
      const index = zset.findIndex((item) => item.member === member);
      if (index >= 0) {
        zset.splice(index, 1);
        return 1;
      }
      return 0;
    }),
    smembers: vi.fn(async (key: string) => {
      const set = sets.get(key);
      return set ? Array.from(set) : [];
    }),
    scard: vi.fn(async (key: string) => {
      const set = sets.get(key);
      return set ? set.size : 0;
    }),
    hset: vi.fn(async (key: string, ...fieldsAndValues: string[]) => {
      if (!hashes.has(key)) hashes.set(key, {});
      const hash = hashes.get(key)!;
      let newCount = 0;
      for (let i = 0; i < fieldsAndValues.length; i += 2) {
        const field = fieldsAndValues[i];
        const value = fieldsAndValues[i + 1] ?? '';
        if (!(field in hash)) newCount++;
        hash[field] = value;
      }
      return newCount;
    }),
    hget: vi.fn(async (key: string, field: string) => {
      const hash = hashes.get(key);
      return hash ? (hash[field] ?? null) : null;
    }),
    hsetnx: vi.fn(async (key: string, field: string, value: string) => {
      if (!hashes.has(key)) hashes.set(key, {});
      const hash = hashes.get(key)!;
      if (field in hash) return 0;
      hash[field] = value;
      return 1;
    }),
    hdel: vi.fn(async (key: string, ...fields: string[]) => {
      const hash = hashes.get(key);
      if (!hash) return 0;
      let count = 0;
      for (const field of fields) {
        if (field in hash) {
          delete hash[field];
          count++;
        }
      }
      return count;
    }),
    setex: vi.fn(async (key: string, _seconds: number, value: string) => {
      store.set(key, value);
      return 'OK';
    }),
    watch: vi.fn(async () => 'OK'),
    unwatch: vi.fn(async () => 'OK'),
    multi: vi.fn(() => {
      const commands: Array<() => Promise<unknown>> = [];
      const chainable = {
        hmset: (key: string, obj: Record<string, string>) => {
          commands.push(() => mockRedis.hmset(key, obj));
          return chainable;
        },
        hset: (key: string, ...fieldsAndValues: string[]) => {
          commands.push(() => mockRedis.hset(key, ...fieldsAndValues));
          return chainable;
        },
        expire: (_key: string, _seconds: number) => {
          commands.push(() => mockRedis.expire(_key, _seconds));
          return chainable;
        },
        zadd: (key: string, score: number, member: string) => {
          commands.push(() => mockRedis.zadd(key, score, member));
          return chainable;
        },
        del: (...keys: string[]) => {
          commands.push(() => mockRedis.del(...keys));
          return chainable;
        },
        sadd: (key: string, ...members: string[]) => {
          commands.push(() => mockRedis.sadd(key, ...members));
          return chainable;
        },
        srem: (key: string, ...members: string[]) => {
          commands.push(() => mockRedis.srem(key, ...members));
          return chainable;
        },
        zrem: (key: string, member: string) => {
          commands.push(() => mockRedis.zrem(key, member));
          return chainable;
        },
        hdel: (key: string, ...fields: string[]) => {
          commands.push(() => mockRedis.hdel(key, ...fields));
          return chainable;
        },
        exec: async () => {
          const results = [];
          for (const cmd of commands) {
            results.push([null, await cmd()]);
          }
          return results;
        },
      };
      return chainable;
    }),
    pipeline: vi.fn(() => {
      const commands: Array<() => Promise<unknown>> = [];
      const chainable = {
        hget: (key: string, field: string) => {
          commands.push(async () => {
            const hash = hashes.get(key);
            return hash ? (hash[field] ?? null) : null;
          });
          return chainable;
        },
        hgetall: (key: string) => {
          commands.push(async () => {
            return hashes.get(key) || {};
          });
          return chainable;
        },
        smembers: (key: string) => {
          commands.push(async () => {
            const set = sets.get(key);
            return set ? Array.from(set) : [];
          });
          return chainable;
        },
        srem: (key: string, ...members: string[]) => {
          commands.push(() => mockRedis.srem(key, ...members));
          return chainable;
        },
        exists: (key: string) => {
          commands.push(async () => {
            return store.has(key) || hashes.has(key) ? 1 : 0;
          });
          return chainable;
        },
        exec: async () => {
          const results = [];
          for (const cmd of commands) {
            results.push([null, await cmd()]);
          }
          return results;
        },
      };
      return chainable;
    }),
    eval: vi.fn(async (_script: string, numkeys: number, ...args: unknown[]) => {
      // numkeys=1 covers three scripts; dispatch on args.length:
      //   RELEASE_LOCK_SCRIPT: args.length === 2 (key, expectedValue)
      //   REFRESH_TTL_SCRIPT:  args.length === 3 (connKey, connTTL, sessionTTL)
      //   UPDATE_USERNAME_SCRIPT: args.length === 4 (connKey, username, avatarUrl, sessionTTL)
      // The original code returned on numkeys===1 unconditionally, which left
      // UPDATE_USERNAME_SCRIPT (and any future numkeys=1 script) as dead
      // code in the mock; tests that exercised them passed vacuously.
      if (numkeys === 1 && args.length === 2) {
        // RELEASE_LOCK_SCRIPT
        const key = args[0] as string;
        const value = args[1] as string;
        if (store.get(key) === value) {
          store.delete(key);
          return 1;
        }
        return 0;
      }
      if (numkeys === 1 && args.length === 3) {
        // REFRESH_TTL_SCRIPT: no-op in mock since EXPIRE is a no-op too. Just
        // report success when the connection hash exists, mirroring the
        // real script's behaviour.
        const connKey = args[0] as string;
        return hashes.has(connKey) ? 1 : 0;
      }
      if (numkeys === 2) {
        // ELECT_NEW_LEADER_SCRIPT: Pick earliest connected candidate
        const sessionMembersKey = args[0] as string;
        const leaderKey = args[1] as string;
        const leavingConnectionId = args[2] as string;

        // Clear old leader's isLeader flag
        const oldLeader = store.get(leaderKey);
        if (oldLeader) {
          const oldLeaderConnKey = Array.from(hashes.keys()).find((k) => hashes.get(k)?.connectionId === oldLeader);
          if (oldLeaderConnKey) {
            hashes.get(oldLeaderConnKey)!.isLeader = 'false';
          }
        }

        // Get candidates (members except leaving)
        const memberSet = sets.get(sessionMembersKey);
        if (!memberSet || memberSet.size === 0) {
          store.delete(leaderKey);
          return null;
        }

        const candidates = Array.from(memberSet).filter((id) => id !== leavingConnectionId);
        if (candidates.length === 0) {
          store.delete(leaderKey);
          return null;
        }

        const newLeader = candidates[0];
        store.set(leaderKey, newLeader);
        const newLeaderConnKey = Array.from(hashes.keys()).find((k) => hashes.get(k)?.connectionId === newLeader);
        if (newLeaderConnKey) {
          hashes.get(newLeaderConnKey)!.isLeader = 'true';
        }
        return newLeader;
      }
      // UPDATE_USERNAME_SCRIPT (numkeys=1, 4 args: connKey, username,
      // avatarUrl-sentinel, sessionTTL). RELEASE_LOCK_SCRIPT and
      // REFRESH_TTL_SCRIPT (also numkeys=1) are dispatched earlier in this
      // function by args.length.
      if (numkeys === 1 && args.length === 4) {
        const connKey = args[0] as string;
        const username = args[1] as string;
        const avatarUrl = args[2] as string;

        if (!hashes.has(connKey)) {
          return 0;
        }
        const connData = hashes.get(connKey)!;
        connData.username = username;
        if (avatarUrl !== UNSET_SENTINEL) connData.avatarUrl = avatarUrl;

        const sessionId = connData.sessionId;
        const participantId = connData.participantId;
        if (sessionId && sessionId !== '' && participantId && participantId !== '') {
          const participantKey = `boardsesh:participant:${sessionId}:${participantId}`;
          if (hashes.has(participantKey)) {
            const partData = hashes.get(participantKey)!;
            partData.username = username;
            if (avatarUrl !== UNSET_SENTINEL) partData.avatarUrl = avatarUrl;
          }
        }
        return 1;
      }
      // REMOVE_PARTICIPANT_CONNECTION_SCRIPT (numkeys=3, 2 ARGV).
      if (numkeys === 3 && args.length === 5) {
        const participantConnectionsKey = args[0] as string;
        const sessionParticipantsKey = args[1] as string;
        const participantKey = args[2] as string;
        const connectionId = args[3] as string;
        const participantId = args[4] as string;

        const connSet = sets.get(participantConnectionsKey);
        if (connSet) connSet.delete(connectionId);
        const remaining = connSet?.size ?? 0;
        if (remaining > 0) return remaining;

        const partSet = sets.get(sessionParticipantsKey);
        if (partSet) partSet.delete(participantId);
        hashes.delete(participantKey);
        sets.delete(participantConnectionsKey);
        return 0;
      }
      // REMOVE_PARTICIPANT_SCRIPT (numkeys=4, 1 ARGV).
      if (numkeys === 4) {
        const sessionParticipantsKey = args[0] as string;
        const participantKey = args[1] as string;
        const participantConnectionsKey = args[2] as string;
        const sessionMembersKey = args[3] as string;
        const participantId = args[4] as string;

        const connectionIds = sets.get(participantConnectionsKey)
          ? Array.from(sets.get(participantConnectionsKey)!)
          : [];
        const partSet = sets.get(sessionParticipantsKey);
        if (partSet) partSet.delete(participantId);
        hashes.delete(participantKey);
        sets.delete(participantConnectionsKey);
        const memberSet = sets.get(sessionMembersKey);
        for (const connectionId of connectionIds) {
          if (memberSet) memberSet.delete(connectionId);
          const connKey = `boardsesh:conn:${connectionId}`;
          if (hashes.has(connKey)) {
            const cd = hashes.get(connKey)!;
            cd.sessionId = '';
            cd.participantId = '';
            cd.isLeader = 'false';
          }
        }
        return connectionIds.length;
      }
      // JOIN_SESSION_SCRIPT new shape (numkeys=6, includes participant writes).
      if (numkeys === 6) {
        const connKey = args[0] as string;
        const sessionMembersKey = args[1] as string;
        const leaderKey = args[2] as string;
        const sessionParticipantsKey = args[3] as string;
        const participantKey = args[4] as string;
        const participantConnectionsKey = args[5] as string;
        const connectionId = args[6] as string;
        const sessionId = args[7] as string;
        const username = args[10] as string;
        const avatarUrl = args[11] as string;
        const participantId = args[12] as string;
        const now = args[13] as string;

        if (!hashes.has(connKey)) {
          return -1;
        }

        const connData = hashes.get(connKey)!;
        connData.connectionId = connectionId;
        connData.sessionId = sessionId;
        if (username && username !== UNSET_SENTINEL) connData.username = username;
        if (avatarUrl !== UNSET_SENTINEL) connData.avatarUrl = avatarUrl;
        connData.isLeader = 'false';

        if (!sets.has(sessionMembersKey)) sets.set(sessionMembersKey, new Set());
        sets.get(sessionMembersKey)!.add(connectionId);

        connData.participantId = participantId;
        const resolvedUsername = connData.username ?? '';
        const resolvedAvatarUrl = connData.avatarUrl ?? '';
        const resolvedUserId = connData.userId ?? '';
        if (!sets.has(sessionParticipantsKey)) sets.set(sessionParticipantsKey, new Set());
        sets.get(sessionParticipantsKey)!.add(participantId);
        hashes.set(participantKey, {
          participantId,
          sessionId,
          userId: resolvedUserId,
          username: resolvedUsername,
          avatarUrl: resolvedAvatarUrl,
          connectionState: 'CONNECTED',
          lastSeenAt: now,
        });
        if (!sets.has(participantConnectionsKey)) sets.set(participantConnectionsKey, new Set());
        sets.get(participantConnectionsKey)!.add(connectionId);

        if (!store.has(leaderKey)) {
          store.set(leaderKey, connectionId);
          connData.isLeader = 'true';
          return 1;
        }
        return 0;
      }
      // numkeys=3 branches by args.length:
      //   - LEAVE_SESSION_SCRIPT: 3 keys + 3 ARGV (connectionId, membersTTL,
      //     leaderTTL) → 6 args total.
      //   - Legacy 3-key JOIN_SESSION_SCRIPT: pre-A8 shape, kept here so an
      //     older test or call site doesn't silently no-op. **Not exercised
      //     in production after A8**; the live script uses numkeys=6 and is
      //     handled above. Future contributors: do not extend this branch
      //     without also updating the production script — the new shape
      //     should be the only path used.
      if (numkeys === 3) {
        const connectionKey = args[0] as string;
        const sessionMembersKey = args[1] as string;
        const leaderKey = args[2] as string;
        const connectionId = args[3] as string;

        if (args.length > 6) {
          // Legacy JOIN_SESSION_SCRIPT path — see comment above. Replaced
          // by the numkeys=6 branch earlier in this function.
          const username = args[7] as string;
          const avatarUrl = args[8] as string;

          // Update connection hash data
          if (!hashes.has(connectionKey)) hashes.set(connectionKey, {});
          const connData = hashes.get(connectionKey)!;
          connData.connectionId = connectionId;
          connData.sessionId = args[4] as string;
          if (username && username !== UNSET_SENTINEL) connData.username = username;
          if (avatarUrl !== undefined && avatarUrl !== UNSET_SENTINEL) connData.avatarUrl = avatarUrl;
          connData.isLeader = 'false';

          // Add to session members set
          if (!sets.has(sessionMembersKey)) sets.set(sessionMembersKey, new Set());
          sets.get(sessionMembersKey)!.add(connectionId);

          // Leader election: if no leader exists, become leader
          if (!store.has(leaderKey)) {
            store.set(leaderKey, connectionId);
            connData.isLeader = 'true';
            return 1; // Became leader
          }
          return 0; // Not leader
        } else {
          // LEAVE_SESSION_SCRIPT: Remove from session, handle leader election
          const memberSet = sets.get(sessionMembersKey);
          if (memberSet) memberSet.delete(connectionId);

          // Clean up connection key
          store.delete(connectionKey);
          hashes.delete(connectionKey);

          // Check if was leader
          const currentLeader = store.get(leaderKey);
          if (currentLeader !== connectionId) {
            return null; // Wasn't leader
          }

          // Was leader - elect new one
          if (memberSet && memberSet.size > 0) {
            const newLeader = Array.from(memberSet)[0];
            store.set(leaderKey, newLeader);
            // Update new leader's connection data
            const newLeaderConnKey = Array.from(hashes.keys()).find((k) => hashes.get(k)?.connectionId === newLeader);
            if (newLeaderConnKey) {
              hashes.get(newLeaderConnKey)!.isLeader = 'true';
            }
            return newLeader;
          }
          store.delete(leaderKey);
          return null;
        }
      }
      // Default
      return null;
    }),
    // For test access
    _store: store,
    _hashes: hashes,
  } as unknown as MockRedis;

  return mockRedis;
};
