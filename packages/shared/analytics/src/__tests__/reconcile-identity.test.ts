import { describe, it, expect } from 'vitest';
import { reconcileAnalyticsIdentity, type IdentityClient } from '../reconcile-identity';

type RecordedCall = [method: string, ...args: unknown[]];

function recordingClient(persistedDistinctId?: string | null): IdentityClient & { calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  return {
    calls,
    getDistinctId() {
      return persistedDistinctId ?? null;
    },
    identify(distinctId, properties) {
      calls.push(['identify', distinctId, properties]);
    },
    reset() {
      calls.push(['reset']);
    },
  };
}

const PROFILE = 'anon-uuid';
const USER = 'user-123';
const OTHER_USER = 'user-456';

describe('reconcileAnalyticsIdentity', () => {
  it('identifies as the anonymous profile when signed out', () => {
    const client = recordingClient();

    const next = reconcileAnalyticsIdentity({
      profileId: PROFILE,
      authUserId: null,
      isAuthenticated: false,
      lastDistinctId: null,
      client,
    });

    expect(next).toBe(PROFILE);
    expect(client.calls).toEqual([['identify', PROFILE, undefined]]);
  });

  it('fresh device + existing account → exactly identify(USER)', () => {
    // The identity-split case: a returning climber signs in on a fresh install.
    // The device is anchored on its anonymous UUID (the SDK is bootstrapped with
    // it and the signed-out launch reconciled to it). The only call allowed is
    // identify(USER), which carries the UUID as $anon_distinct_id. An alias()
    // ahead of it is what left a phantom newcomer behind.
    const client = recordingClient(PROFILE);

    const next = reconcileAnalyticsIdentity({
      profileId: PROFILE,
      authUserId: USER,
      authEmail: 'a@b.com',
      isAuthenticated: true,
      lastDistinctId: PROFILE,
      client,
    });

    expect(next).toBe(USER);
    expect(client.calls).toEqual([['identify', USER, { email: 'a@b.com' }]]);
  });

  it('sends the same single identify on every sign-in, with no per-device memory', () => {
    // The alias step was deduped through a persisted store. With it gone, two
    // sign-ins from the same anonymous anchor must look identical.
    const firstClient = recordingClient(PROFILE);
    const secondClient = recordingClient(PROFILE);
    const input = {
      profileId: PROFILE,
      authUserId: USER,
      isAuthenticated: true,
      lastDistinctId: PROFILE,
    };

    reconcileAnalyticsIdentity({ ...input, client: firstClient });
    reconcileAnalyticsIdentity({ ...input, client: secondClient });

    expect(firstClient.calls).toEqual([['identify', USER, undefined]]);
    expect(secondClient.calls).toEqual(firstClient.calls);
  });

  it('keeps the merge call off the client contract', () => {
    // The reconciler can only call what IdentityClient declares. If this
    // directive stops being needed, someone has put the merge call back on the
    // contract: read the header of reconcile-identity.ts before going further.
    const client: IdentityClient = {
      identify() {},
      reset() {},
      // @ts-expect-error IdentityClient must not declare alias()
      alias() {},
    };

    expect(Object.keys(client)).toContain('identify');
  });

  it('is a no-op when already identified as the user', () => {
    const client = recordingClient();
    const next = reconcileAnalyticsIdentity({
      profileId: PROFILE,
      authUserId: USER,
      isAuthenticated: true,
      lastDistinctId: USER,
      client,
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
    });

    expect(next).toBe(PROFILE);
    expect(client.calls).toEqual([['reset'], ['identify', PROFILE, undefined]]);
  });

  it('resets, re-anchors on the anonymous profile, then switches when the account changes', () => {
    const client = recordingClient(OTHER_USER);
    const next = reconcileAnalyticsIdentity({
      profileId: PROFILE,
      authUserId: USER,
      isAuthenticated: true,
      lastDistinctId: OTHER_USER,
      client,
    });

    expect(next).toBe(USER);
    expect(client.calls).toEqual([['reset'], ['identify', PROFILE, undefined], ['identify', USER, undefined]]);
  });

  it('first-run authenticated anchors on the anonymous profile then switches', () => {
    const client = recordingClient();
    const next = reconcileAnalyticsIdentity({
      profileId: PROFILE,
      authUserId: USER,
      authEmail: 'a@b.com',
      isAuthenticated: true,
      lastDistinctId: null,
      client,
    });

    expect(next).toBe(USER);
    expect(client.calls).toEqual([
      ['identify', PROFILE, undefined],
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
    });

    expect(next).toBe(PROFILE);
    expect(client.calls).toEqual([]);
  });

  it('skips the anon round-trip on a cold start already identified as this user', () => {
    // The ref is null at every mount, but the SDK persists distinct_id across
    // launches. Without the guard this fires identify(anon) then identify(user)
    // on every single launch — the bulk of the project's $identify volume.
    const client = recordingClient(USER);

    const next = reconcileAnalyticsIdentity({
      profileId: PROFILE,
      authUserId: USER,
      authEmail: 'climber@example.com',
      isAuthenticated: true,
      lastDistinctId: null,
      client,
    });

    expect(next).toBe(USER);
    expect(client.calls).toEqual([]);
  });

  it('still runs the full anon → user switch when the SDK holds a different id', () => {
    const client = recordingClient(PROFILE);

    const next = reconcileAnalyticsIdentity({
      profileId: PROFILE,
      authUserId: USER,
      authEmail: 'climber@example.com',
      isAuthenticated: true,
      lastDistinctId: null,
      client,
    });

    expect(next).toBe(USER);
    expect(client.calls).toEqual([
      ['identify', PROFILE, undefined],
      ['identify', USER, { email: 'climber@example.com' }],
    ]);
  });

  it('falls back to the old behaviour when the client cannot report a distinct id', () => {
    const calls: RecordedCall[] = [];
    const client: IdentityClient = {
      identify(distinctId, properties) {
        calls.push(['identify', distinctId, properties]);
      },
      reset() {
        calls.push(['reset']);
      },
    };

    reconcileAnalyticsIdentity({
      profileId: PROFILE,
      authUserId: USER,
      isAuthenticated: true,
      lastDistinctId: null,
      client,
    });

    expect(calls).toEqual([
      ['identify', PROFILE, undefined],
      ['identify', USER, undefined],
    ]);
  });
});
