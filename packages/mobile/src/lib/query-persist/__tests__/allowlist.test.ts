import { describe, it, expect } from 'vitest';
import { matchPersistRule, PERSISTED_QUERY_RULES } from '../allowlist';

const OWNER = 'user-1';

describe('matchPersistRule', () => {
  // T-01: the six allowlisted shapes match, and everything the decision doc
  // excludes misses. Arity is what makes this a gate rather than a prefix
  // filter, so the near-misses matter as much as the hits.
  it('matches exactly the six allowlisted key shapes', () => {
    expect(matchPersistRule(['profile'], OWNER)?.head).toBe('profile');
    expect(matchPersistRule(['myBoards', undefined], OWNER)?.head).toBe('myBoards');
    expect(matchPersistRule(['myBoards', { boardType: 'kilter' }], OWNER)?.head).toBe('myBoards');
    expect(matchPersistRule(['myGyms'], OWNER)?.head).toBe('myGyms');
    expect(matchPersistRule(['grades', 'kilter'], OWNER)?.head).toBe('grades');
    expect(matchPersistRule(['angles', 'kilter', 8], OWNER)?.head).toBe('angles');
    expect(matchPersistRule(['publicProfile', OWNER], OWNER)?.head).toBe('publicProfile');
  });

  it('rejects wrong arity, near-miss heads, and every SQLite-owned key', () => {
    // Wrong arity on an allowlisted head.
    expect(matchPersistRule(['profile', 'x'], OWNER)).toBeUndefined();
    expect(matchPersistRule(['myBoards'], OWNER)).toBeUndefined();
    expect(matchPersistRule(['angles', 'kilter'], OWNER)).toBeUndefined();
    // A future key that would slip through a prefix check.
    expect(matchPersistRule(['profileSettings'], OWNER)).toBeUndefined();
    // SQLite owns these.
    expect(matchPersistRule(['searchClimbs', { query: 'x' }], OWNER)).toBeUndefined();
    expect(matchPersistRule(['infiniteSearchClimbs', { query: 'x' }], OWNER)).toBeUndefined();
    expect(matchPersistRule(['logbook', 'kilter'], OWNER)).toBeUndefined();
    expect(matchPersistRule(['userTicks', 'u1'], OWNER)).toBeUndefined();
    // Already AsyncStorage-backed; double-storing it is explicitly out of scope.
    expect(matchPersistRule(['activeBoard'], OWNER)).toBeUndefined();
    // "Now" semantics.
    expect(matchPersistRule(['sessionGroupedFeed'], OWNER)).toBeUndefined();
    // A non-string head can never match.
    expect(matchPersistRule([42], OWNER)).toBeUndefined();
    expect(matchPersistRule([], OWNER)).toBeUndefined();
  });

  // T-02: publicProfile is the only rule with a guard — someone else's public
  // profile is another climber's data and must never land on this device's disk.
  it('persists only the owner’s own publicProfile', () => {
    expect(matchPersistRule(['publicProfile', OWNER], OWNER)).toBeDefined();
    expect(matchPersistRule(['publicProfile', 'someone-else'], OWNER)).toBeUndefined();
  });

  it('gives publicProfile the shortest maxAge and the lowest priority', () => {
    const publicProfile = PERSISTED_QUERY_RULES.find((rule) => rule.head === 'publicProfile');
    const profile = PERSISTED_QUERY_RULES.find((rule) => rule.head === 'profile');
    expect(publicProfile?.maxAgeMs).toBe(24 * 60 * 60 * 1000);
    expect(profile?.maxAgeMs).toBe(14 * 24 * 60 * 60 * 1000);
    // `profile` is the entry the feature exists for, so it evicts last.
    const priorities = PERSISTED_QUERY_RULES.map((rule) => rule.priority);
    expect(profile?.priority).toBe(Math.max(...priorities));
    expect(publicProfile?.priority).toBe(Math.min(...priorities));
  });
});
