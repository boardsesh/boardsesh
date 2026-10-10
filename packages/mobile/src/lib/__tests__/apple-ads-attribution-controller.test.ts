import { describe, expect, it, vi } from 'vitest';
import type { MobileConsentSnapshot } from '../consent-state';
import type { AppleAdsAttributionResult } from '@boardsesh/shared-schema/apple-ads-attribution';
import type { AppleAdsTokenResult } from '../../../modules/apple-ads-attribution/src';
import {
  APPLE_ADS_TOKEN_TTL_MS,
  createAppleAdsAttributionController,
  parseStoredAppleAdsAttribution,
  type AppleAdsAttributionDependencies,
  type StoredAppleAdsAttribution,
} from '../apple-ads-attribution-controller';

const OWNER = 'e24bfa22-98e9-4a5f-84d8-9e805671a62a';
const OTHER = 'b912ad98-f0c2-48e4-bb45-c247970d0748';
const EVENT_UUID = '27dba32e-a6fa-4b36-9d19-fec73ec43338';
const ATTRIBUTED: AppleAdsAttributionResult = {
  status: 'ATTRIBUTED',
  attribution: { orgId: '12', campaignId: '34', adGroupId: '56', conversionType: 'Download' },
  retryAfterSeconds: null,
  retryReason: null,
};
const RETRYABLE: AppleAdsAttributionResult = {
  status: 'RETRYABLE',
  attribution: null,
  retryAfterSeconds: 5,
  retryReason: 'not_ready',
};

function deferred<T>() {
  let resolve!: (result: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function fixture(accountId: string | null = OWNER, cache: unknown = null) {
  let stored = cache;
  let now = Date.parse('2026-10-10T08:00:00Z');
  let verifiedAccountId = accountId;
  let distinctId = accountId ?? 'anonymous';
  const snapshot: MobileConsentSnapshot = {
    loaded: true,
    settled: true,
    killed: false,
    authSettled: true,
    accountResolved: true,
    authEpoch: 1,
    accountId,
    sdkReady: true,
    flagsResolved: true,
    record: { analytics: 'granted', version: 1, source: 'ios', decidedAt: '2026-10-10T07:59:00Z' },
  };
  const authority = () =>
    snapshot.loaded &&
    snapshot.settled &&
    snapshot.authSettled &&
    snapshot.accountResolved &&
    !snapshot.killed &&
    snapshot.record?.analytics === 'granted';
  const dependencies: AppleAdsAttributionDependencies = {
    snapshot: () => snapshot,
    verifiedAccountId: () => verifiedAccountId,
    authorityGranted: authority,
    publicationGranted: () => authority() && snapshot.sdkReady,
    identity: () => ({ distinctId, anonymousId: 'anonymous' }),
    read: vi.fn(async () => stored),
    write: vi.fn(async (record) => {
      stored = structuredClone(record);
    }),
    token: vi.fn(async (): Promise<AppleAdsTokenResult> => ({ status: 'available', token: 'secret-sentinel-token' })),
    exchange: vi.fn(async () => ATTRIBUTED),
    publish: vi.fn(() => true),
    delay: vi.fn(async (milliseconds) => {
      now += milliseconds;
    }),
    now: () => now,
    uuid: () => EVENT_UUID,
  };
  return {
    dependencies,
    snapshot,
    stored: () => stored as StoredAppleAdsAttribution,
    advance: (milliseconds: number) => {
      now += milliseconds;
    },
    account: (ownerId: string | null) => {
      verifiedAccountId = ownerId;
      snapshot.accountId = ownerId;
      distinctId = ownerId ?? 'anonymous';
      snapshot.authEpoch += 1;
    },
    identity: (identity: string) => {
      distinctId = identity;
    },
    deny: () => {
      snapshot.record = { ...snapshot.record!, analytics: 'denied', decidedAt: '2026-10-10T08:01:00Z' };
    },
    allow: () => {
      snapshot.record = { ...snapshot.record!, analytics: 'granted', decidedAt: '2026-10-10T08:02:00Z' };
    },
  };
}

describe('Apple Ads attribution lifecycle', () => {
  it('does not acquire or publish before Allow', async () => {
    const harness = fixture();
    harness.deny();
    await createAppleAdsAttributionController(harness.dependencies).reconcile();
    expect(harness.dependencies.token).not.toHaveBeenCalled();
    expect(harness.dependencies.exchange).not.toHaveBeenCalled();
    expect(harness.dependencies.publish).not.toHaveBeenCalled();
  });

  it('persists normalized attribution, publishes once, and never stores a token', async () => {
    const harness = fixture();
    const controller = createAppleAdsAttributionController(harness.dependencies);
    await controller.reconcile();
    await controller.reconcile();
    await createAppleAdsAttributionController(harness.dependencies).reconcile();
    expect(harness.dependencies.token).toHaveBeenCalledTimes(1);
    expect(harness.dependencies.publish).toHaveBeenCalledTimes(1);
    expect(harness.stored().ownerId).toBe(OWNER);
    expect(JSON.stringify(harness.stored())).not.toContain('secret-sentinel-token');
  });

  it('holds publication until the SDK has the exact verified account', async () => {
    const harness = fixture();
    harness.identity(OTHER);
    const controller = createAppleAdsAttributionController(harness.dependencies);
    await controller.reconcile();
    expect(harness.dependencies.publish).not.toHaveBeenCalled();
    expect(harness.stored().eventPublished).toBe(false);
    harness.identity(OWNER);
    await controller.reconcile();
    expect(harness.dependencies.publish).toHaveBeenCalledTimes(1);
  });

  it('attaches anonymous attribution to its first account without repeating the event', async () => {
    const harness = fixture(null);
    const controller = createAppleAdsAttributionController(harness.dependencies);
    await controller.reconcile();
    harness.account(OWNER);
    await controller.reconcile();
    expect(harness.dependencies.publish).toHaveBeenNthCalledWith(1, expect.any(Object), 'anonymous', true);
    expect(harness.dependencies.publish).toHaveBeenNthCalledWith(2, expect.any(Object), OWNER, false);
    expect(harness.stored().ownerId).toBe(OWNER);
  });

  it('cancels when withdrawal happens during native acquisition', async () => {
    const harness = fixture();
    const pendingToken = deferred<AppleAdsTokenResult>();
    harness.dependencies.token = vi.fn(() => pendingToken.promise);
    const controller = createAppleAdsAttributionController(harness.dependencies);
    const pending = controller.reconcile();
    await vi.waitFor(() => expect(harness.dependencies.token).toHaveBeenCalled());
    harness.deny();
    void controller.reconcile();
    pendingToken.resolve({ status: 'available', token: 'secret-sentinel-token' });
    await pending;
    expect(harness.dependencies.exchange).not.toHaveBeenCalled();
    expect(harness.dependencies.publish).not.toHaveBeenCalled();
    expect(harness.stored().result).toBeNull();
  });

  it('aborts an exchange and retains only the owner when consent is withdrawn', async () => {
    const harness = fixture();
    const response = deferred<AppleAdsAttributionResult>();
    harness.dependencies.exchange = vi.fn(() => response.promise);
    const controller = createAppleAdsAttributionController(harness.dependencies);
    const pending = controller.reconcile();
    await vi.waitFor(() => expect(harness.dependencies.exchange).toHaveBeenCalled());
    harness.deny();
    void controller.reconcile();
    expect(vi.mocked(harness.dependencies.exchange).mock.calls[0]?.[2].aborted).toBe(true);
    response.resolve(ATTRIBUTED);
    await pending;
    expect(harness.dependencies.publish).not.toHaveBeenCalled();
    expect(harness.stored().result).toBeNull();
    expect(harness.stored().ownerId).toBe(OWNER);
  });

  it('never rebinds a late response or a persisted install from A to B', async () => {
    const harness = fixture();
    const response = deferred<AppleAdsAttributionResult>();
    harness.dependencies.exchange = vi.fn(() => response.promise);
    const controller = createAppleAdsAttributionController(harness.dependencies);
    const pending = controller.reconcile();
    await vi.waitFor(() => expect(harness.dependencies.exchange).toHaveBeenCalled());
    harness.account(OTHER);
    void controller.reconcile();
    response.resolve(ATTRIBUTED);
    await pending;
    await createAppleAdsAttributionController(harness.dependencies).reconcile();
    expect(harness.stored().ownerId).toBe(OWNER);
    expect(harness.stored().result).toBeNull();
    expect(harness.dependencies.publish).not.toHaveBeenCalled();
    expect(harness.dependencies.token).toHaveBeenCalledTimes(1);
  });

  it('serializes withdrawal cleanup after a pending disk write', async () => {
    const harness = fixture();
    const pendingWrite = deferred<void>();
    const write = harness.dependencies.write;
    harness.dependencies.write = vi.fn(async (record) => {
      if (record.result) await pendingWrite.promise;
      await write(record);
    });
    const controller = createAppleAdsAttributionController(harness.dependencies);
    const pending = controller.reconcile();
    await vi.waitFor(() =>
      expect(harness.dependencies.write).toHaveBeenCalledWith(expect.objectContaining({ result: ATTRIBUTED })),
    );
    harness.deny();
    void controller.reconcile();
    pendingWrite.resolve();
    await pending;
    await controller.reconcile();
    expect(harness.stored().result).toBeNull();
    expect(harness.dependencies.publish).not.toHaveBeenCalled();
  });

  it.each(['withdrawal', 'signout', 'replacement', 'anonymous withdrawal'] as const)(
    'retries failed %s cleanup after storage recovers on foreground',
    async (transition) => {
      const harness = fixture(transition === 'anonymous withdrawal' ? null : OWNER);
      const controller = createAppleAdsAttributionController(harness.dependencies);
      await controller.reconcile();
      expect(harness.stored().result).toEqual(ATTRIBUTED);
      const write = harness.dependencies.write;
      harness.dependencies.write = vi.fn(async () => {
        throw new Error('Storage temporarily unavailable');
      });
      if (transition === 'signout') harness.account(null);
      else if (transition === 'replacement') harness.account(OTHER);
      else harness.deny();
      await controller.reconcile();
      expect(harness.stored().result).toEqual(ATTRIBUTED);

      harness.dependencies.write = write;
      await controller.reconcile();
      expect(harness.stored().result).toBeNull();
      expect(harness.stored().propertiesPublishedFor).toBeNull();
      expect(harness.stored().ownerId).toBe(transition === 'anonymous withdrawal' ? null : OWNER);
      expect(harness.stored().closed).toBe(transition === 'anonymous withdrawal');
      expect(harness.dependencies.token).toHaveBeenCalledTimes(1);
      expect(harness.dependencies.publish).toHaveBeenCalledTimes(1);
      if (transition === 'anonymous withdrawal') {
        harness.allow();
        harness.account(OTHER);
        await createAppleAdsAttributionController(harness.dependencies).reconcile();
        expect(harness.dependencies.token).toHaveBeenCalledTimes(1);
      }
    },
  );

  it('bounds not-ready retries to three attempts five seconds apart', async () => {
    const harness = fixture();
    harness.dependencies.exchange = vi.fn(async () => RETRYABLE);
    const controller = createAppleAdsAttributionController(harness.dependencies);
    await controller.reconcile();
    await controller.reconcile();
    expect(harness.dependencies.exchange).toHaveBeenCalledTimes(3);
    expect(harness.dependencies.delay).toHaveBeenCalledTimes(2);
    expect(harness.dependencies.delay).toHaveBeenCalledWith(5_000, expect.any(AbortSignal));
    harness.advance(60_000);
    await controller.reconcile();
    expect(harness.dependencies.token).toHaveBeenCalledTimes(2);
  });

  it('does not reuse a token that expires between attempts', async () => {
    const harness = fixture();
    harness.dependencies.exchange = vi.fn(async () => RETRYABLE);
    harness.dependencies.delay = vi.fn(async () => {
      harness.advance(APPLE_ADS_TOKEN_TTL_MS);
    });
    await createAppleAdsAttributionController(harness.dependencies).reconcile();
    expect(harness.dependencies.exchange).toHaveBeenCalledTimes(1);
  });

  it('keeps missing modules and test responses out of product analytics', async () => {
    const missing = fixture();
    missing.dependencies.token = vi.fn(async (): Promise<AppleAdsTokenResult> => ({ status: 'unavailable' }));
    await createAppleAdsAttributionController(missing.dependencies).reconcile();
    expect(missing.dependencies.publish).not.toHaveBeenCalled();
    const simulated = fixture();
    simulated.dependencies.exchange = vi.fn(async (): Promise<AppleAdsAttributionResult> => ({
      status: 'TEST',
      attribution: null,
      retryAfterSeconds: null,
      retryReason: null,
    }));
    await createAppleAdsAttributionController(simulated.dependencies).reconcile();
    expect(simulated.dependencies.publish).not.toHaveBeenCalled();
  });

  it('does not mark publication when the SDK forwarding gate skips it', async () => {
    const harness = fixture();
    harness.dependencies.publish = vi.fn(() => false);
    await createAppleAdsAttributionController(harness.dependencies).reconcile();
    expect(harness.stored().eventPublished).toBe(false);
    expect(harness.stored().propertiesPublishedFor).toBeNull();
  });

  it('requires a durable owner lock before publication', async () => {
    const harness = fixture();
    harness.dependencies.write = vi.fn(async () => {
      throw new Error('disk unavailable');
    });
    const controller = createAppleAdsAttributionController(harness.dependencies);
    await controller.reconcile();
    await controller.reconcile();
    expect(harness.dependencies.publish).not.toHaveBeenCalled();
  });

  it('fails closed if storage could hide a previous install owner', async () => {
    const harness = fixture(OTHER, { version: 'corrupt' });
    await createAppleAdsAttributionController(harness.dependencies).reconcile();
    expect(harness.dependencies.token).not.toHaveBeenCalled();
    expect(harness.dependencies.publish).not.toHaveBeenCalled();
  });

  it('allows fresh same-owner acquisition after withdrawal without restoring old events', async () => {
    const harness = fixture();
    const controller = createAppleAdsAttributionController(harness.dependencies);
    await controller.reconcile();
    harness.deny();
    await controller.reconcile();
    harness.allow();
    await controller.reconcile();
    expect(harness.dependencies.token).toHaveBeenCalledTimes(2);
    expect(vi.mocked(harness.dependencies.publish).mock.calls.filter(([, , emitEvent]) => emitEvent)).toHaveLength(1);
  });

  it('revalidates cached fields and strips unrelated payload', async () => {
    const harness = fixture();
    await createAppleAdsAttributionController(harness.dependencies).reconcile();
    const cache = harness.stored();
    expect(
      parseStoredAppleAdsAttribution({
        ...cache,
        token: 'secret',
        result: { ...ATTRIBUTED, attribution: { ...ATTRIBUTED.attribution, token: 'secret' } },
      }),
    ).toEqual(cache);
  });
});
