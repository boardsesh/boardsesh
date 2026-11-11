import {
  isAnalyticsGranted,
  isRegionDefaultConsent,
  needsPrompt,
  type ConsentRecord,
  type DeviceConsentRecord,
} from '@boardsesh/consent';

export type MobileConsentSnapshot = {
  /** The device answer; `ownerAccountId` says which account it was given under (none when signed out). */
  record: DeviceConsentRecord | null;
  loaded: boolean;
  settled: boolean;
  killed: boolean;
  authSettled: boolean;
  accountResolved: boolean;
  authEpoch: number;
  accountId: string | null;
  sdkReady: boolean;
  flagsResolved: boolean;
  /**
   * This launch's region lookup said the prompt is not needed here. A stored
   * region default counts as "on" only once it has, so it sends nothing before
   * the lookup answers, and nothing when the lookup fails. Reset when a long
   * background makes the answer stale (see ConsentGate).
   */
  regionConfirmed: boolean;
};

let snapshot: MobileConsentSnapshot = {
  record: null,
  loaded: false,
  settled: false,
  killed: false,
  authSettled: false,
  accountResolved: false,
  authEpoch: 0,
  accountId: null,
  sdkReady: false,
  flagsResolved: false,
  regionConfirmed: false,
};
const listeners = new Set<() => void>();
let readBrowserConsent: (() => ConsentRecord | null) | null = null;

export function getConsentSnapshot(): MobileConsentSnapshot {
  return snapshot;
}

export function subscribeConsent(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function updateConsentState(update: Partial<MobileConsentSnapshot>): void {
  if (
    update.sdkReady !== true &&
    (update.accountResolved === false ||
      update.authSettled === false ||
      update.flagsResolved === false ||
      update.killed === true ||
      update.settled === false ||
      ('accountId' in update && update.accountId !== snapshot.accountId))
  )
    update = { ...update, sdkReady: false };
  if (
    'record' in update &&
    needsPrompt(update.record ?? null) &&
    !(update.killed ?? snapshot.killed) &&
    process.env.EXPO_PUBLIC_SCREENSHOT_MODE !== '1'
  )
    update = { ...update, settled: false };
  if (snapshot.killed && update.killed === false && needsPrompt(snapshot.record))
    update = { ...update, settled: false };
  if (Object.entries(update).every(([key, entry]) => Object.is(snapshot[key as keyof MobileConsentSnapshot], entry)))
    return;
  snapshot = { ...snapshot, ...update };
  for (const listener of listeners) listener();
}

export function setBrowserConsentReader(reader: () => ConsentRecord | null): void {
  readBrowserConsent = reader;
}

export function invalidateConsentAccount(): void {
  updateConsentState({
    authSettled: false,
    accountResolved: false,
    sdkReady: false,
    accountId: null,
    authEpoch: snapshot.authEpoch + 1,
  });
}

/** Also read the shared cookie at capture time: other subdomains cannot broadcast to this origin. */
export function isConsentAuthorityGranted(): boolean {
  // Reading the shared cookie can synchronously invalidate account authority.
  // Evaluate the updated snapshot after that observation, including pending denial.
  readBrowserConsent?.();
  if (snapshot.killed || process.env.EXPO_PUBLIC_SCREENSHOT_MODE === '1') return false;
  return (
    snapshot.loaded &&
    snapshot.settled &&
    snapshot.flagsResolved &&
    snapshot.authSettled &&
    snapshot.accountResolved &&
    isAnalyticsGranted(snapshot.record) &&
    (!isRegionDefaultConsent(snapshot.record) || snapshot.regionConfirmed)
  );
}

export function isProductAnalyticsGranted(): boolean {
  return isConsentAuthorityGranted() && snapshot.sdkReady;
}

/**
 * Install attribution (Apple Ads, the Play install referrer) needs the
 * climber's own Allow everywhere. The region default does not turn it on.
 */
export function isAttributionAuthorityGranted(): boolean {
  return isConsentAuthorityGranted() && !isRegionDefaultConsent(snapshot.record);
}

export function isAttributionPublicationGranted(): boolean {
  return isProductAnalyticsGranted() && !isRegionDefaultConsent(snapshot.record);
}
