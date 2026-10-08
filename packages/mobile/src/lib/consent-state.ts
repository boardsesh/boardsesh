import { isAnalyticsGranted, needsPrompt, type ConsentRecord } from '@boardsesh/consent';

export type MobileConsentSnapshot = {
  record: ConsentRecord | null;
  loaded: boolean;
  settled: boolean;
  killed: boolean;
  authSettled: boolean;
  accountResolved: boolean;
  authEpoch: number;
  accountId: string | null;
  sdkReady: boolean;
  flagsResolved: boolean;
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
    isAnalyticsGranted(snapshot.record)
  );
}

export function isProductAnalyticsGranted(): boolean {
  return isConsentAuthorityGranted() && snapshot.sdkReady;
}
