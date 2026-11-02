import { isAnalyticsGranted, isRegionDefaultConsent } from '@boardsesh/consent';
import { getConsentSnapshot, subscribeConsent } from './consent-state';

export const AUTH_CONVERSION_WAIT_MS = 2 * 60_000;

export type AuthAnalyticsHandoff = {
  signedInAt: Date;
  explicit: boolean;
  isCurrent(): boolean;
  bindAccount(accountId: string): boolean;
  accountId(): string | null;
  retainsIdentity(distinctId: string, anonymousId: string): boolean;
  dispose(): void;
};

const handoffs = new Set<AuthAnalyticsHandoff>();
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

export function subscribeAuthAnalyticsHandoff(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Existing consent is evidence for a bounded hold, never authority to send. */
export function createAuthAnalyticsHandoff({
  credentialCurrent,
  identity,
}: {
  credentialCurrent: () => boolean;
  identity: { distinctId: string; anonymousId: string } | null;
}): AuthAnalyticsHandoff {
  const origin = getConsentSnapshot();
  const signedInAt = new Date();
  const deadline = signedInAt.getTime() + AUTH_CONVERSION_WAIT_MS;
  let valid =
    origin.loaded &&
    !origin.killed &&
    isAnalyticsGranted(origin.record) &&
    (!isRegionDefaultConsent(origin.record) || origin.regionConfirmed);
  let owner: string | null = null;
  let boundEpoch: number | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let unsubscribe = () => {};
  const dispose = () => {
    if (!valid) return;
    valid = false;
    clearTimeout(timer);
    unsubscribe();
    handoffs.delete(handoff);
    notify();
  };
  const isCurrent = () => {
    if (!valid) return false;
    const current = getConsentSnapshot();
    if (
      Date.now() >= deadline ||
      !credentialCurrent() ||
      !current.loaded ||
      current.killed ||
      current.record?.analytics === 'denied' ||
      (isRegionDefaultConsent(origin.record) && !current.regionConfirmed) ||
      (boundEpoch !== null && current.authEpoch !== boundEpoch) ||
      (owner !== null && current.accountId !== null && current.accountId !== owner)
    ) {
      dispose();
      return false;
    }
    return true;
  };
  const handoff: AuthAnalyticsHandoff = {
    signedInAt,
    explicit: !isRegionDefaultConsent(origin.record),
    isCurrent,
    bindAccount(accountId) {
      const originOwner = origin.accountId ?? origin.record?.ownerAccountId ?? null;
      if (
        !isCurrent() ||
        (owner !== null && owner !== accountId) ||
        (originOwner !== null && originOwner !== accountId)
      ) {
        dispose();
        return false;
      }
      owner = accountId;
      boundEpoch = getConsentSnapshot().authEpoch;
      notify();
      return true;
    },
    accountId: () => (isCurrent() ? owner : null),
    retainsIdentity(distinctId, anonymousId) {
      if (!isCurrent()) return false;
      if (distinctId === owner) return true;
      return distinctId === anonymousId && identity !== null && distinctId === identity.anonymousId;
    },
    dispose,
  };
  if (valid) {
    handoffs.add(handoff);
    unsubscribe = subscribeConsent(isCurrent);
    timer = setTimeout(dispose, AUTH_CONVERSION_WAIT_MS);
    notify();
  }
  return handoff;
}

export function retainAuthAnalyticsIdentity(distinctId: string, anonymousId: string): boolean {
  return [...handoffs].some((handoff) => handoff.retainsIdentity(distinctId, anonymousId));
}

export function hasAuthAnalyticsHandoff(): boolean {
  return [...handoffs].some((handoff) => handoff.isCurrent());
}

export function getAttributionAuthHandoff(): AuthAnalyticsHandoff | null {
  return [...handoffs].find((handoff) => handoff.explicit && handoff.isCurrent()) ?? null;
}

export function cancelAuthAnalyticsHandoffs(): void {
  for (const handoff of handoffs) handoff.dispose();
}
