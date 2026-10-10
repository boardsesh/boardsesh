import { isAnalyticsGranted, type ConsentRecord } from '@boardsesh/consent';
import {
  normalizeAppleAdsAttributionPayload,
  type AppleAdsAttributionResult,
} from '@boardsesh/shared-schema/apple-ads-attribution';
import type { AppleAdsTokenResult } from '../../modules/apple-ads-attribution/src';
import type { MobileConsentSnapshot } from './consent-state';

export const APPLE_ADS_ATTRIBUTION_STORAGE_KEY = 'appleAdsAttributionV1';
export const APPLE_ADS_TOKEN_TTL_MS = 24 * 60 * 60 * 1_000;
const RETRY_COOLDOWN_MS = 60_000;

export type StoredAppleAdsAttribution = {
  version: 1;
  ownerId: string | null;
  eventUuid: string;
  observedAt: string;
  result: AppleAdsAttributionResult | null;
  eventPublished: boolean;
  propertiesPublishedFor: string | null;
  closed: boolean;
};

export type AppleAdsAttributionDependencies = {
  snapshot(): MobileConsentSnapshot;
  verifiedAccountId(): string | null;
  authorityGranted(): boolean;
  publicationGranted(): boolean;
  identity(): { distinctId: string; anonymousId: string } | null;
  read(): Promise<unknown>;
  write(record: StoredAppleAdsAttribution): Promise<void>;
  token(): Promise<AppleAdsTokenResult>;
  exchange(token: string, consent: ConsentRecord, signal: AbortSignal): Promise<AppleAdsAttributionResult>;
  publish(record: StoredAppleAdsAttribution, distinctId: string, emitEvent: boolean): boolean;
  delay(milliseconds: number, signal: AbortSignal): Promise<void>;
  uuid(): string;
  now(): number;
};

function nullableIdentifier(candidate: unknown): candidate is string | null {
  return candidate === null || (typeof candidate === 'string' && candidate.length > 0 && candidate.length <= 128);
}

/** Pick only the versioned, non-secret cache contract; never trust parsed JSON. */
export function parseStoredAppleAdsAttribution(candidate: unknown): StoredAppleAdsAttribution | null {
  if (typeof candidate !== 'object' || candidate === null) return null;
  const record = candidate as Record<string, unknown>;
  if (
    record.version !== 1 ||
    !nullableIdentifier(record.ownerId) ||
    !nullableIdentifier(record.propertiesPublishedFor) ||
    typeof record.eventUuid !== 'string' ||
    !/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(record.eventUuid) ||
    typeof record.observedAt !== 'string' ||
    !Number.isFinite(Date.parse(record.observedAt)) ||
    typeof record.eventPublished !== 'boolean' ||
    typeof record.closed !== 'boolean'
  )
    return null;

  let result: AppleAdsAttributionResult | null = null;
  if (record.result !== null) {
    if (typeof record.result !== 'object' || record.result === null) return null;
    const cachedResult = record.result as Record<string, unknown>;
    if (cachedResult.status === 'ATTRIBUTED') {
      if (typeof cachedResult.attribution !== 'object' || cachedResult.attribution === null) return null;
      result = normalizeAppleAdsAttributionPayload({ ...cachedResult.attribution, attribution: true });
      if (result.status !== 'ATTRIBUTED') return null;
    } else if (cachedResult.status === 'UNATTRIBUTED' || cachedResult.status === 'TEST') {
      result = { status: cachedResult.status, attribution: null, retryAfterSeconds: null, retryReason: null };
    } else return null;
  }
  return {
    version: 1,
    ownerId: record.ownerId,
    eventUuid: record.eventUuid,
    observedAt: record.observedAt,
    result,
    eventPublished: record.eventPublished,
    propertiesPublishedFor: record.propertiesPublishedFor,
    closed: record.closed,
  };
}

/** One bounded worker, with synchronous cancellation and serialized disk writes. */
export function createAppleAdsAttributionController(dependencies: AppleAdsAttributionDependencies) {
  let stored: StoredAppleAdsAttribution | null = null;
  let loaded = false;
  let disposed = false;
  let authEpoch = dependencies.snapshot().authEpoch;
  let consentStamp = dependencies.snapshot().record?.decidedAt;
  let generation = 0;
  let controller: AbortController | null = null;
  let running: Promise<void> | null = null;
  let rerun = false;
  let retryAt = 0;
  let writes = Promise.resolve();

  function persist(): Promise<void> {
    // Read the latest state when the write starts, rather than enqueueing a
    // captured payload that could resurrect attribution after withdrawal.
    writes = writes
      .catch(() => {})
      .then(async () => {
        if (stored) await dependencies.write({ ...stored });
      });
    return writes;
  }

  function cancel(): void {
    generation += 1;
    controller?.abort();
    controller = null;
  }

  function observeAuthority(): void {
    const snapshot = dependencies.snapshot();
    if (snapshot.authEpoch !== authEpoch || snapshot.record?.decidedAt !== consentStamp) {
      cancel();
      authEpoch = snapshot.authEpoch;
      consentStamp = snapshot.record?.decidedAt;
      retryAt = 0;
    }
    if (!dependencies.authorityGranted()) cancel();
    if (!stored) return;
    const denied = snapshot.loaded && (snapshot.killed || !isAnalyticsGranted(snapshot.record));
    const verifiedAccountId = dependencies.verifiedAccountId();
    const replaced = stored.ownerId !== null && verifiedAccountId !== null && stored.ownerId !== verifiedAccountId;
    const signedOut =
      stored.ownerId !== null && snapshot.authSettled && snapshot.accountResolved && snapshot.accountId === null;
    if (denied || replaced || signedOut) {
      const changed =
        stored.result !== null || stored.propertiesPublishedFor !== null || (!stored.ownerId && !stored.closed);
      stored = {
        ...stored,
        result: null,
        propertiesPublishedFor: null,
        closed: stored.closed || stored.ownerId === null,
      };
      if (changed) void persist().catch(() => {});
      return;
    }
    // Seal the install as soon as auth proves its account, even while account
    // consent/SDK identity is resolving. A later account can never claim it.
    if (!stored.ownerId && !stored.closed && verifiedAccountId && isAnalyticsGranted(snapshot.record)) {
      stored = { ...stored, ownerId: verifiedAccountId };
      void persist().catch(() => {});
    }
  }

  function current(capturedGeneration: number): boolean {
    return !disposed && generation === capturedGeneration && dependencies.authorityGranted();
  }

  function eligibleOwner(): boolean {
    if (!stored || stored.closed) return false;
    const snapshot = dependencies.snapshot();
    const verifiedAccountId = dependencies.verifiedAccountId();
    if (verifiedAccountId !== snapshot.accountId) return false;
    return stored.ownerId === verifiedAccountId;
  }

  async function publish(): Promise<void> {
    if (!stored?.result || stored.result.status === 'TEST' || !eligibleOwner() || !dependencies.publicationGranted())
      return;
    // Publication requires the ownership lock to survive a process restart.
    // A previous failed write must not become permission to publish in memory.
    await persist();
    if (!stored?.result || !eligibleOwner() || !dependencies.publicationGranted()) return;
    const identity = dependencies.identity();
    if (!identity) return;
    const expectedId = stored.ownerId ?? identity.anonymousId;
    if (identity.distinctId !== expectedId) return;
    if (stored.eventPublished && stored.propertiesPublishedFor === expectedId) return;
    if (!dependencies.publish(stored, expectedId, !stored.eventPublished)) return;
    stored = { ...stored, eventPublished: true, propertiesPublishedFor: expectedId };
    await persist();
  }

  async function run(): Promise<void> {
    if (!loaded) {
      // A failed storage read must stop acquisition: it could hide a prior
      // account's ownership lock. The next foreground may retry the read.
      const cached = await dependencies.read();
      stored = parseStoredAppleAdsAttribution(cached);
      if (cached !== null && stored === null) throw new Error('Invalid attribution ownership record');
      loaded = true;
    }
    observeAuthority();
    if (disposed || !dependencies.authorityGranted()) return;
    if (!stored) {
      stored = {
        version: 1,
        ownerId: dependencies.verifiedAccountId(),
        eventUuid: dependencies.uuid(),
        observedAt: new Date(dependencies.now()).toISOString(),
        result: null,
        eventPublished: false,
        propertiesPublishedFor: null,
        closed: false,
      };
      await persist();
    }
    observeAuthority();
    if (!eligibleOwner() || !dependencies.authorityGranted()) return;
    if (stored.result) {
      await publish();
      return;
    }
    if (dependencies.now() < retryAt) return;
    const capturedGeneration = generation;
    controller = new AbortController();
    const signal = controller.signal;
    const tokenResult = await dependencies.token();
    if (!current(capturedGeneration)) return;
    if (tokenResult.status !== 'available') {
      retryAt = dependencies.now() + RETRY_COOLDOWN_MS;
      return;
    }
    const tokenCreatedAt = dependencies.now();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (!current(capturedGeneration) || dependencies.now() - tokenCreatedAt >= APPLE_ADS_TOKEN_TTL_MS) return;
      const record = dependencies.snapshot().record;
      if (!record) return;
      const result = await dependencies.exchange(tokenResult.token, record, signal);
      if (!current(capturedGeneration) || !eligibleOwner()) return;
      if (result.status === 'ATTRIBUTED' || result.status === 'UNATTRIBUTED' || result.status === 'TEST') {
        stored = { ...stored, result };
        await persist();
        if (!current(capturedGeneration)) return;
        await publish();
        return;
      }
      if (result.status !== 'RETRYABLE') {
        retryAt = dependencies.now() + RETRY_COOLDOWN_MS;
        return;
      }
      if (attempt < 2) {
        await dependencies.delay(Math.max(5, Math.min(result.retryAfterSeconds ?? 5, 60)) * 1_000, signal);
      }
    }
    retryAt = dependencies.now() + RETRY_COOLDOWN_MS;
  }

  function reconcile(): Promise<void> {
    if (disposed) return Promise.resolve();
    observeAuthority();
    if (running) {
      rerun = true;
      return running;
    }
    running = run()
      .catch(() => {
        // This worker owns potentially sensitive transport failures. Only a
        // fixed cooldown escapes; raw exceptions never reach diagnostics.
        retryAt = dependencies.now() + RETRY_COOLDOWN_MS;
      })
      .finally(() => {
        running = null;
        if (rerun && !disposed) {
          rerun = false;
          void reconcile();
        }
      });
    return running;
  }

  return {
    reconcile,
    dispose(): void {
      disposed = true;
      cancel();
    },
  };
}
