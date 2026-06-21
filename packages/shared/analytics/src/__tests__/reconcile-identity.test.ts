import { describe, it, expect } from 'vitest';
import { reconcileAnalyticsIdentity, type AliasDedupeStore, type IdentityClient } from '../reconcile-identity';

function recordingClient(aliasReturns?: unknown): IdentityClient & {
  calls: Array<[string, ...unknown[]]>;
} {
  const calls: Array<[string, ...unknown[]]> = [];
  return {
    calls,
    identify(distinctId, properties) {
      calls.push(['identify', distinctId, properties]);
    },
    reset() {
      calls.push(['reset']);
    },
    alias(newId) {
      calls.push(['alias', newId]);
      return aliasReturns;
    },
  };
}

function memoryAliasStore(): AliasDedupeStore & { pairs: Set<string> } {
  const pairs = new Set<string>();
  return {
    pairs,
    hasRecordedAlias(profileId, userId) {
      return pairs.has(`${profileId}->${userId}`);
    },
    recordAlias(profileId, userId) {
      pairs.add(`${profileId}->${userId}`);
    },
  };
}

const PROFILE = 'anon-uuid';
const USER = 'user-123';

describe('reconcileAnalyticsIdentity', () => {
  it('identifies as the anonymous profile when signed out', () => {
    const client = recordingClient();
    const aliasStore = memoryAliasStore();

    const next = reconcileAnalyticsIdentity({
      profileId: PROFILE,
      authUserId: null,
      isAuthenticated: false,
      lastDistinctId: null,
      client,
      aliasStore,
    });

    expect(next).toBe(PROFILE);
    expect(client.calls).toEqual([['identify', PROFILE, undefined]]);
  });

  it('aliases anon → user exactly once and switches identity on login', () => {
    const client = recordingClient();
    const aliasStore = memoryAliasStore();

    const next = reconcileAnalyticsIdentity({
      profileId: PROFILE,
      authUserId: USER,
      authEmail: 'a@b.com',
      isAuthenticated: true,
      lastDistinctId: PROFILE,
      client,
      aliasStore,
    });

    expect(next).toBe(USER);
    expect(client.calls).toEqual([
      ['alias', USER],
      ['identify', USER, { email: 'a@b.com' }],
    ]);
    expect(aliasStore.hasRecordedAlias(PROFILE, USER)).toBe(true);
  });

  it('does not re-alias on a subsequent run once recorded', () => {
    const aliasStore = memoryAliasStore();
    aliasStore.recordAlias(PROFILE, USER);
    const client = recordingClient();

    reconcileAnalyticsIdentity({
      profileId: PROFILE,
      authUserId: USER,
      authEmail: 'a@b.com',
      isAuthenticated: true,
      lastDistinctId: PROFILE,
      client,
      aliasStore,
    });

    expect(client.calls.some(([method]) => method === 'alias')).toBe(false);
    expect(client.calls).toEqual([['identify', USER, { email: 'a@b.com' }]]);
  });

  it('is a no-op when already identified as the user', () => {
    const client = recordingClient();
    const next = reconcileAnalyticsIdentity({
      profileId: PROFILE,
      authUserId: USER,
      isAuthenticated: true,
      lastDistinctId: USER,
      client,
      aliasStore: memoryAliasStore(),
    });

    expect(next).toBe(USER);
    expect(client.calls).toEqual([]);
  });

  it('resets and re-identifies as the anonymous profile on logout', () => {
    const client = recordingClient();
    const next = reconcileAnalyticsIdentity({
      profileId: PROFILE,
      authUserId: null,
      isAuthenticated: false,
      lastDistinctId: USER,
      client,
      aliasStore: memoryAliasStore(),
    });

    expect(next).toBe(PROFILE);
    expect(client.calls).toEqual([['reset'], ['identify', PROFILE, undefined]]);
  });

  it('does not record the alias pair when the client reports alias failed (false)', () => {
    const client = recordingClient(false);
    const aliasStore = memoryAliasStore();

    reconcileAnalyticsIdentity({
      profileId: PROFILE,
      authUserId: USER,
      isAuthenticated: true,
      lastDistinctId: PROFILE,
      client,
      aliasStore,
    });

    expect(client.calls.some(([method]) => method === 'alias')).toBe(true);
    expect(aliasStore.hasRecordedAlias(PROFILE, USER)).toBe(false);
  });

  it('first-run authenticated identifies anon then aliases then switches', () => {
    const client = recordingClient();
    const next = reconcileAnalyticsIdentity({
      profileId: PROFILE,
      authUserId: USER,
      authEmail: 'a@b.com',
      isAuthenticated: true,
      lastDistinctId: null,
      client,
      aliasStore: memoryAliasStore(),
    });

    expect(next).toBe(USER);
    expect(client.calls).toEqual([
      ['identify', PROFILE, undefined],
      ['alias', USER],
      ['identify', USER, { email: 'a@b.com' }],
    ]);
  });

  it('holds the current identity when authenticated but the user id has not resolved yet', () => {
    const client = recordingClient();
    const next = reconcileAnalyticsIdentity({
      profileId: PROFILE,
      authUserId: null,
      isAuthenticated: true,
      lastDistinctId: PROFILE,
      client,
      aliasStore: memoryAliasStore(),
    });

    expect(next).toBe(PROFILE);
    expect(client.calls).toEqual([]);
  });
});
