import { describe, it, expect } from 'vitest';
import { reconcileAnalyticsIdentity, type AnalyticsIdentityAction, type IdentityClient } from '../reconcile-identity';

// A model of what @posthog/core 1.48.8 does with identify() and reset(), so the
// tests assert the events that reach PostHog and not only the calls the
// reconciler makes. Mirrors posthog-core.js:
//  - getDistinctId() is the persisted distinct id, or else the anonymous id;
//  - getAnonymousId() mints and persists an id when there is none;
//  - identify() to a new id reads `$anon_distinct_id` BEFORE the identity
//    moves, then keeps the previous distinct id as the anonymous id;
//  - identify() to the id the SDK already holds sends `$set`, never
//    `$identify`, and still flips the person mode to identified;
//  - reset() clears both ids and the person mode.
//
// `anonAlreadyIdentified` is the model's one statement about the server: it is
// true when the `$anon_distinct_id` on an `$identify` was itself part of an
// earlier `$identify`. That is the shape PostHog refuses to merge.
type WireEvent =
  | { event: '$identify'; distinctId: string; anonDistinctId: string; anonAlreadyIdentified: boolean }
  | { event: '$set'; distinctId: string };

type SdkState = { anonymousId: string | null; distinctId: string | null; personMode: 'identified' | null };

function sdkModel(initial: Partial<SdkState>, mintedIds: string[] = []) {
  const state: SdkState = { anonymousId: null, distinctId: null, personMode: null, ...initial };
  const pendingMints = [...mintedIds];
  const sent: WireEvent[] = [];
  const calls: Array<[method: string, ...args: unknown[]]> = [];
  // Every id that has been on either side of an `$identify`, seeded from a
  // starting state that is already pinned.
  const identifiedIds = new Set<string>();
  if (state.distinctId && state.anonymousId && state.distinctId !== state.anonymousId) {
    identifiedIds.add(state.distinctId);
    identifiedIds.add(state.anonymousId);
  }

  function readAnonymousId(): string {
    if (!state.anonymousId) {
      const minted = pendingMints.shift();
      if (!minted) throw new Error('sdkModel ran out of minted anonymous ids');
      state.anonymousId = minted;
    }
    return state.anonymousId;
  }

  function readDistinctId(): string {
    return state.distinctId ?? readAnonymousId();
  }

  const client: IdentityClient = {
    getDistinctId: readDistinctId,
    getAnonymousId: readAnonymousId,
    identify(nextDistinctId, properties) {
      calls.push(['identify', nextDistinctId, properties]);
      const previousDistinctId = readDistinctId();
      const anonDistinctId = readAnonymousId();
      if (nextDistinctId === previousDistinctId) {
        state.personMode = 'identified';
        sent.push({ event: '$set', distinctId: nextDistinctId });
        return;
      }
      state.anonymousId = previousDistinctId;
      state.distinctId = nextDistinctId;
      state.personMode = 'identified';
      sent.push({
        event: '$identify',
        distinctId: nextDistinctId,
        anonDistinctId,
        anonAlreadyIdentified: identifiedIds.has(anonDistinctId),
      });
      identifiedIds.add(nextDistinctId);
      identifiedIds.add(anonDistinctId);
    },
    reset() {
      calls.push(['reset']);
      state.anonymousId = null;
      state.distinctId = null;
      state.personMode = null;
    },
  };

  return { client, sent, calls, state };
}

type Sdk = ReturnType<typeof sdkModel>;

const USER = 'user-123';
const OTHER_USER = 'user-456';
const PARTY = 'party-profile-uuid-v4';
const FIRST_ANON = 'sdk-anon-1';
const SECOND_ANON = 'sdk-anon-2';
const THIRD_ANON = 'sdk-anon-3';

function signedOut(sdk: Sdk): AnalyticsIdentityAction {
  return reconcileAnalyticsIdentity({ authUserId: null, isAuthenticated: false, client: sdk.client });
}

function signedInPending(sdk: Sdk): AnalyticsIdentityAction {
  return reconcileAnalyticsIdentity({ authUserId: null, isAuthenticated: true, client: sdk.client });
}

function signedIn(sdk: Sdk, userId: string, email?: string): AnalyticsIdentityAction {
  return reconcileAnalyticsIdentity({
    authUserId: userId,
    authEmail: email ?? null,
    isAuthenticated: true,
    client: sdk.client,
  });
}

describe('reconcileAnalyticsIdentity: signed out', () => {
  it('pristine install: sends nothing and leaves the SDK anonymous', () => {
    const sdk = sdkModel({}, [FIRST_ANON]);

    expect(signedOut(sdk)).toBe('none');

    expect(sdk.calls).toEqual([]);
    expect(sdk.sent).toEqual([]);
    expect(sdk.state).toEqual({ anonymousId: FIRST_ANON, distinctId: null, personMode: null });
  });

  it('relaunch while signed out: no identify, no reset, same anonymous id', () => {
    // The SDK persisted its anonymous id on the first launch. The old routine
    // reset here on every cold start and then identified the party UUID.
    const sdk = sdkModel({ anonymousId: FIRST_ANON });

    expect(signedOut(sdk)).toBe('none');
    expect(signedOut(sdk)).toBe('none');

    expect(sdk.calls).toEqual([]);
    expect(sdk.state.anonymousId).toBe(FIRST_ANON);
  });

  it('sign-out: one reset, no identify, and the next anonymous id is new', () => {
    const sdk = sdkModel({ anonymousId: FIRST_ANON, distinctId: USER, personMode: 'identified' }, [SECOND_ANON]);

    expect(signedOut(sdk)).toBe('reset');
    // Later renders of the signed-out state must not reset again.
    expect(signedOut(sdk)).toBe('none');

    expect(sdk.calls).toEqual([['reset']]);
    expect(sdk.sent).toEqual([]);
    expect(sdk.client.getDistinctId()).toBe(SECOND_ANON);
  });

  it('a reset someone else already made is not repeated', () => {
    // AuthProvider resets inside its own sign-out cleanup, before this routine
    // sees the signed-out state. The SDK is anonymous by then.
    const sdk = sdkModel({ anonymousId: FIRST_ANON, distinctId: USER, personMode: 'identified' }, [SECOND_ANON]);
    sdk.client.reset();
    sdk.calls.length = 0;

    expect(signedOut(sdk)).toBe('none');

    expect(sdk.calls).toEqual([]);
  });
});

describe('reconcileAnalyticsIdentity: signed in', () => {
  it('sign-in from anonymous: exactly identify(USER), carrying an anonymous id nothing identified before', () => {
    const sdk = sdkModel({ anonymousId: FIRST_ANON });
    signedOut(sdk);

    expect(signedIn(sdk, USER, 'a@b.com')).toBe('identify');

    expect(sdk.calls).toEqual([['identify', USER, { email: 'a@b.com' }]]);
    expect(sdk.sent).toEqual([
      { event: '$identify', distinctId: USER, anonDistinctId: FIRST_ANON, anonAlreadyIdentified: false },
    ]);
  });

  it('holds while authenticated with the user id still pending, then switches once', () => {
    const sdk = sdkModel({ anonymousId: FIRST_ANON });

    expect(signedInPending(sdk)).toBe('hold');
    expect(signedInPending(sdk)).toBe('hold');
    expect(sdk.calls).toEqual([]);

    expect(signedIn(sdk, USER)).toBe('identify');
    expect(signedIn(sdk, USER)).toBe('none');

    expect(sdk.calls).toEqual([['identify', USER, undefined]]);
  });

  it('cold start already identified as this user: no call', () => {
    const sdk = sdkModel({ anonymousId: FIRST_ANON, distinctId: USER, personMode: 'identified' });

    expect(signedIn(sdk, USER, 'climber@example.com')).toBe('none');

    expect(sdk.calls).toEqual([]);
  });

  it('account switch with no signed-out render between: reset, then identify the new user', () => {
    const sdk = sdkModel({ anonymousId: FIRST_ANON, distinctId: OTHER_USER, personMode: 'identified' }, [SECOND_ANON]);

    expect(signedIn(sdk, USER)).toBe('reset-and-identify');

    expect(sdk.calls).toEqual([['reset'], ['identify', USER, undefined]]);
    // The new user's $identify must not carry the previous user's ids.
    expect(sdk.sent).toEqual([
      { event: '$identify', distinctId: USER, anonDistinctId: SECOND_ANON, anonAlreadyIdentified: false },
    ]);
  });

  it('account switch through a sign-out: one reset and one identify', () => {
    const sdk = sdkModel({ anonymousId: FIRST_ANON, distinctId: OTHER_USER, personMode: 'identified' }, [SECOND_ANON]);

    signedOut(sdk);
    signedIn(sdk, USER);

    expect(sdk.calls).toEqual([['reset'], ['identify', USER, undefined]]);
  });
});

describe('reconcileAnalyticsIdentity: install upgraded from the party-UUID routine', () => {
  // What an OTA finds on a device that last ran the old routine while signed
  // out: the SDK is pinned to the party UUID and the anonymous id it minted is
  // already attached to that identified person.
  const upgraded = (): Sdk =>
    sdkModel({ anonymousId: FIRST_ANON, distinctId: PARTY, personMode: 'identified' }, [SECOND_ANON, THIRD_ANON]);

  it('signed out: resets once, then stays put on later launches', () => {
    const sdk = upgraded();

    expect(signedOut(sdk)).toBe('reset');
    expect(signedOut(sdk)).toBe('none');
    expect(signedOut(sdk)).toBe('none');

    expect(sdk.calls).toEqual([['reset']]);
    expect(sdk.sent).toEqual([]);
    expect(sdk.client.getDistinctId()).toBe(SECOND_ANON);
  });

  it('the sign-in after that carries a clean anonymous id', () => {
    const sdk = upgraded();
    signedOut(sdk);

    signedIn(sdk, USER);

    expect(sdk.sent).toEqual([
      { event: '$identify', distinctId: USER, anonDistinctId: SECOND_ANON, anonAlreadyIdentified: false },
    ]);
  });

  it('signed in before any signed-out pass: reset first, so the party person is never offered for a merge', () => {
    // A session that signed in on the old bundle but never fetched the user id.
    const sdk = upgraded();

    expect(signedInPending(sdk)).toBe('hold');
    expect(signedIn(sdk, USER)).toBe('reset-and-identify');

    expect(sdk.calls).toEqual([['reset'], ['identify', USER, undefined]]);
    expect(sdk.sent).toEqual([
      { event: '$identify', distinctId: USER, anonDistinctId: SECOND_ANON, anonAlreadyIdentified: false },
    ]);
  });

  it('without the reset the sign-in would carry an anonymous id PostHog has already identified', () => {
    // Pins why the one-time reset is there. This is the old sign-in, driven by
    // hand: identify(USER) straight from the pinned party state.
    const sdk = upgraded();

    sdk.client.identify(USER);

    expect(sdk.sent).toEqual([
      { event: '$identify', distinctId: USER, anonDistinctId: FIRST_ANON, anonAlreadyIdentified: true },
    ]);
  });

  it('an install whose anonymous id IS the party UUID is treated as anonymous and keeps it', () => {
    // The state the old bootstrap aimed for. It is anonymous by the SDK's own
    // test, so there is nothing to reset and the sign-in can merge it.
    const sdk = sdkModel({ anonymousId: PARTY, personMode: 'identified' });

    expect(signedOut(sdk)).toBe('none');
    expect(signedIn(sdk, USER)).toBe('identify');

    expect(sdk.calls).toEqual([['identify', USER, undefined]]);
    expect(sdk.sent).toEqual([
      { event: '$identify', distinctId: USER, anonDistinctId: PARTY, anonAlreadyIdentified: false },
    ]);
  });
});

describe('reconcileAnalyticsIdentity: whole lifecycle', () => {
  it('install, three signed-out launches, sign in, relaunch, sign out, relaunch, another account', () => {
    const sdk = sdkModel({}, [FIRST_ANON, SECOND_ANON]);

    signedOut(sdk);
    signedOut(sdk);
    signedOut(sdk);
    signedInPending(sdk);
    signedIn(sdk, USER, 'a@b.com');
    signedIn(sdk, USER, 'a@b.com');
    signedOut(sdk);
    signedOut(sdk);
    signedIn(sdk, OTHER_USER);

    expect(sdk.calls).toEqual([
      ['identify', USER, { email: 'a@b.com' }],
      ['reset'],
      ['identify', OTHER_USER, undefined],
    ]);
    expect(sdk.sent).toEqual([
      { event: '$identify', distinctId: USER, anonDistinctId: FIRST_ANON, anonAlreadyIdentified: false },
      { event: '$identify', distinctId: OTHER_USER, anonDistinctId: SECOND_ANON, anonAlreadyIdentified: false },
    ]);
  });
});

describe('reconcileAnalyticsIdentity: contract', () => {
  function staticClient(distinctId: string | null, anonymousId: string | null) {
    const calls: Array<[method: string, ...args: unknown[]]> = [];
    const client: IdentityClient = {
      getDistinctId: () => distinctId,
      getAnonymousId: () => anonymousId,
      identify(nextDistinctId, properties) {
        calls.push(['identify', nextDistinctId, properties]);
      },
      reset() {
        calls.push(['reset']);
      },
    };
    return { client, calls };
  }

  it.each([
    ['no client', null, null],
    ['SDK storage not loaded yet', '', ''],
  ])('holds and sends nothing when the SDK cannot say who it is (%s)', (_label, distinctId, anonymousId) => {
    const { client, calls } = staticClient(distinctId, anonymousId);

    expect(reconcileAnalyticsIdentity({ authUserId: null, isAuthenticated: false, client })).toBe('hold');
    expect(reconcileAnalyticsIdentity({ authUserId: USER, isAuthenticated: true, client })).toBe('hold');

    expect(calls).toEqual([]);
  });

  it('never identifies the anonymous id, whatever state it starts from', () => {
    const starts: Array<Partial<SdkState>> = [
      {},
      { anonymousId: FIRST_ANON },
      { anonymousId: FIRST_ANON, distinctId: USER, personMode: 'identified' },
      { anonymousId: FIRST_ANON, distinctId: PARTY, personMode: 'identified' },
    ];

    for (const start of starts) {
      const sdk = sdkModel(start, [SECOND_ANON, THIRD_ANON]);
      signedOut(sdk);
      signedOut(sdk);
      expect(sdk.calls.filter(([method]) => method === 'identify')).toEqual([]);
    }
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
      getDistinctId: () => null,
      getAnonymousId: () => null,
      // @ts-expect-error IdentityClient must not declare alias()
      alias() {},
    };

    expect(Object.keys(client)).toContain('identify');
  });
});
