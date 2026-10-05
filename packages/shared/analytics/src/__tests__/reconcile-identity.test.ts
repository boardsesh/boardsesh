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
    // identify(USER): no alias() ahead of it.
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

  it('keeps the merge call off the client contract', () => {
    // The reconciler can only call what IdentityClient declares. The guard is
    // the @ts-expect-error below, so it fires under `vp run typecheck`, not
    // under vitest: the runtime assertion only keeps this a valid test. If the
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

// A model of what @posthog/core 1.48.8 does with identify() and reset(), so the
// tests below can assert the `$identify` events that reach PostHog and not only
// the calls the reconciler makes. Mirrors posthog-core.js: `$anon_distinct_id`
// is read from the persisted anonymous id BEFORE the identity moves; an
// identify() to the id the SDK already holds sends `$set`, never `$identify`;
// reset() clears both ids and the next read mints a fresh anonymous id.
type WireEvent = { event: '$identify' | '$set'; distinctId: string; anonDistinctId?: string };

function sdkModel(initial: { anonymousId: string | null; distinctId?: string | null }, mintedIds: string[]) {
  let anonymousId = initial.anonymousId;
  let distinctId = initial.distinctId ?? null;
  const pendingMints = [...mintedIds];
  const sent: WireEvent[] = [];

  function readAnonymousId(): string {
    if (!anonymousId) {
      const minted = pendingMints.shift();
      if (!minted) throw new Error('sdkModel ran out of minted anonymous ids');
      anonymousId = minted;
    }
    return anonymousId;
  }

  const client: IdentityClient = {
    getDistinctId() {
      return distinctId ?? readAnonymousId();
    },
    identify(nextDistinctId) {
      const previousDistinctId = distinctId ?? readAnonymousId();
      const anonDistinctId = readAnonymousId();
      if (nextDistinctId === previousDistinctId) {
        sent.push({ event: '$set', distinctId: nextDistinctId });
        return;
      }
      anonymousId = previousDistinctId;
      distinctId = nextDistinctId;
      sent.push({ event: '$identify', distinctId: nextDistinctId, anonDistinctId });
    },
    reset() {
      anonymousId = null;
      distinctId = null;
    },
  };

  return { client, sent };
}

function signOutThenIn(
  sdk: ReturnType<typeof sdkModel>,
  startingDistinctId: string | null,
  options: { skipSignedOutLaunch?: boolean } = {},
): void {
  let lastDistinctId = startingDistinctId;
  if (!options.skipSignedOutLaunch) {
    lastDistinctId = reconcileAnalyticsIdentity({
      profileId: PROFILE,
      authUserId: null,
      isAuthenticated: false,
      lastDistinctId,
      client: sdk.client,
    });
  }
  reconcileAnalyticsIdentity({
    profileId: PROFILE,
    authUserId: USER,
    isAuthenticated: true,
    lastDistinctId,
    client: sdk.client,
  });
}

const MINTED = 'sdk-minted-anon';

describe('reconcileAnalyticsIdentity: SDK anonymous id on the sign-in $identify', () => {
  it('bootstrapped install: the sign-in $identify carries the party UUID, and nothing identifies it first', () => {
    // The clean path. The SDK's anonymous id IS the party UUID, so the
    // signed-out identify(profileId) is only a $set and the anonymous person is
    // never marked identified. PostHog can merge it into the account.
    const sdk = sdkModel({ anonymousId: PROFILE }, []);

    signOutThenIn(sdk, null);

    expect(sdk.sent).toEqual([
      { event: '$set', distinctId: PROFILE },
      { event: '$identify', distinctId: USER, anonDistinctId: PROFILE },
    ]);
  });

  // The next three pin today's behaviour in the states where the SDK's
  // anonymous id is NOT the party UUID. Each one sends $identify(PROFILE) while
  // signed out, which marks the anonymous person identified, and then a sign-in
  // $identify whose $anon_distinct_id is the minted id and not the party UUID.
  // That is the suspected cause of the identity split (see the module header),
  // so a change that fixes it is expected to rewrite these expectations.
  it('KNOWN GAP after a sign-out: reset() drops the bootstrap, so the anonymous person gets identified', () => {
    const sdk = sdkModel({ anonymousId: PROFILE, distinctId: OTHER_USER }, [MINTED]);

    signOutThenIn(sdk, OTHER_USER);

    expect(sdk.sent).toEqual([
      { event: '$identify', distinctId: PROFILE, anonDistinctId: MINTED },
      { event: '$identify', distinctId: USER, anonDistinctId: MINTED },
    ]);
  });

  it('KNOWN GAP when the SDK persisted its own anonymous id: same two $identify events', () => {
    // Bootstrap only fills an empty slot, so an anonymous id the SDK minted on
    // an earlier launch wins over the party UUID.
    const sdk = sdkModel({ anonymousId: MINTED }, []);

    signOutThenIn(sdk, null);

    expect(sdk.sent).toEqual([
      { event: '$identify', distinctId: PROFILE, anonDistinctId: MINTED },
      { event: '$identify', distinctId: USER, anonDistinctId: MINTED },
    ]);
  });

  it('KNOWN GAP on a signed-in cold start with a minted anonymous id: the anchor step identifies the party UUID', () => {
    const sdk = sdkModel({ anonymousId: MINTED }, []);

    signOutThenIn(sdk, null, { skipSignedOutLaunch: true });

    expect(sdk.sent).toEqual([
      { event: '$identify', distinctId: PROFILE, anonDistinctId: MINTED },
      { event: '$identify', distinctId: USER, anonDistinctId: MINTED },
    ]);
  });
});
