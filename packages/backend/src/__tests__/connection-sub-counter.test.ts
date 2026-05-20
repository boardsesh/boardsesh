import { describe, it, expect } from 'vite-plus/test';
import {
  MAX_SUBS_PER_CONNECTION,
  decrementConnectionSubCount,
  getConnectionSubCount,
  incrementConnectionSubCount,
} from '../graphql/resolvers/ticks/connection-sub-counter';

describe('connection-sub-counter', () => {
  it('increments and decrements the per-connection count', () => {
    const conn = `test-${Math.random()}`;
    expect(getConnectionSubCount(conn)).toBe(0);
    incrementConnectionSubCount(conn);
    expect(getConnectionSubCount(conn)).toBe(1);
    incrementConnectionSubCount(conn);
    expect(getConnectionSubCount(conn)).toBe(2);
    decrementConnectionSubCount(conn);
    expect(getConnectionSubCount(conn)).toBe(1);
    decrementConnectionSubCount(conn);
    expect(getConnectionSubCount(conn)).toBe(0);
  });

  it('throws when a connection exceeds the per-connection cap', () => {
    const conn = `cap-${Math.random()}`;
    for (let i = 0; i < MAX_SUBS_PER_CONNECTION; i++) {
      incrementConnectionSubCount(conn);
    }
    expect(() => incrementConnectionSubCount(conn)).toThrow(/Too many climb-stats subscriptions/);
    // Cleanup so isolated test state doesn't bleed into other test files.
    for (let i = 0; i < MAX_SUBS_PER_CONNECTION; i++) {
      decrementConnectionSubCount(conn);
    }
  });

  it('clamps to zero on extra decrements (no negative count, no stale entry)', () => {
    const conn = `clamp-${Math.random()}`;
    decrementConnectionSubCount(conn);
    decrementConnectionSubCount(conn);
    expect(getConnectionSubCount(conn)).toBe(0);
  });
});
