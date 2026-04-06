import { vi } from 'vitest';
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
      const hasNX = opts.some(o => typeof o === 'string' && o.toUpperCase() === 'NX');
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
    hset: vi.fn(async (key: string, field: string, value: string) => {
      if (!hashes.has(key)) hashes.set(key, {});
      const hash = hashes.get(key)!;
      const isNew = !(field in hash);
      hash[field] = value;
      return isNew ? 1 : 0;
    }),
    setex: vi.fn(async (key: string, _seconds: number, value: string) => {
      store.set(key, value);
      return 'OK';
    }),
    scan: vi.fn(async (cursor: string, ...args: unknown[]) => {
      // Parse MATCH pattern and COUNT from variadic args
      let pattern = '*';
      for (let i = 0; i < args.length - 1; i++) {
        if (typeof args[i] === 'string' && args[i].toString().toUpperCase() === 'MATCH') {
          pattern = args[i + 1] as string;
        }
      }
      // Convert glob pattern to regex (only supports * wildcard)
      const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
      // Collect all known keys from all data structures
      const allKeys = new Set<string>([
        ...store.keys(),
        ...sets.keys(),
        ...hashes.keys(),
        ...sortedSets.keys(),
      ]);
      const matched = Array.from(allKeys).filter(k => regex.test(k));
      // cursor '0' means start; always return '0' (done) since we scan everything at once
      return ['0', matched] as [string, string[]];
    }),
    keys: vi.fn(async (pattern: string) => {
      const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
      const allKeys = new Set<string>([
        ...store.keys(),
        ...sets.keys(),
        ...hashes.keys(),
        ...sortedSets.keys(),
      ]);
      return Array.from(allKeys).filter(k => regex.test(k));
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
        hset: (key: string, field: string, value: string) => {
          commands.push(() => mockRedis.hset(key, field, value));
          return chainable;
        },
        expire: (_key: string, _seconds: number) => {
          commands.push(() => mockRedis.expire(_key, _seconds));
          return chainable;
        },
        setex: (key: string, seconds: number, value: string) => {
          commands.push(() => mockRedis.setex(key, seconds, value));
          return chainable;
        },
        set: (key: string, value: string, ...opts: unknown[]) => {
          commands.push(() => mockRedis.set(key, value, ...opts));
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
        exists: (key: string) => {
          commands.push(async () => {
            return store.has(key) || hashes.has(key) ? 1 : 0;
          });
          return chainable;
        },
        del: (...keys: string[]) => {
          commands.push(async () => {
            let count = 0;
            for (const key of keys) {
              if (store.delete(key)) count++;
              if (sets.delete(key)) count++;
              if (hashes.delete(key)) count++;
              if (sortedSets.delete(key)) count++;
            }
            return count;
          });
          return chainable;
        },
        set: (key: string, value: string, ...opts: unknown[]) => {
          commands.push(() => mockRedis.set(key, value, ...opts));
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
        expire: (key: string, seconds: number) => {
          commands.push(() => mockRedis.expire(key, seconds));
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
      // RELEASE_LOCK_SCRIPT (numkeys=1): Delete key if value matches
      if (numkeys === 1) {
        const key = args[0] as string;
        const value = args[1] as string;
        if (store.get(key) === value) {
          store.delete(key);
          return 1;
        }
        return 0;
      }
      // REFRESH_TTL_SCRIPT (numkeys=1 handled above)
      // ELECT_NEW_LEADER_SCRIPT (numkeys=2): handled below
      if (numkeys === 2) {
        // ELECT_NEW_LEADER_SCRIPT: Pick earliest connected candidate
        const sessionMembersKey = args[0] as string;
        const leaderKey = args[1] as string;
        const leavingConnectionId = args[2] as string;

        // Clear old leader's isLeader flag
        const oldLeader = store.get(leaderKey);
        if (oldLeader) {
          const oldLeaderConnKey = Array.from(hashes.keys()).find(k =>
            hashes.get(k)?.connectionId === oldLeader
          );
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

        const candidates = Array.from(memberSet).filter(id => id !== leavingConnectionId);
        if (candidates.length === 0) {
          store.delete(leaderKey);
          return null;
        }

        const newLeader = candidates[0];
        store.set(leaderKey, newLeader);
        const newLeaderConnKey = Array.from(hashes.keys()).find(k =>
          hashes.get(k)?.connectionId === newLeader
        );
        if (newLeaderConnKey) {
          hashes.get(newLeaderConnKey)!.isLeader = 'true';
        }
        return newLeader;
      }
      // numkeys=3: Both JOIN and LEAVE use 3 keys
      // Distinguish by argument count: JOIN has 9+ args, LEAVE has 6
      if (numkeys === 3) {
        const connectionKey = args[0] as string;
        const sessionMembersKey = args[1] as string;
        const leaderKey = args[2] as string;
        const connectionId = args[3] as string;

        if (args.length > 6) {
          // JOIN_SESSION_SCRIPT: Store connection, add to members, leader election
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
            const newLeaderConnKey = Array.from(hashes.keys()).find(k =>
              hashes.get(k)?.connectionId === newLeader
            );
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
