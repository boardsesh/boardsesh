import { isAnalyticsGranted } from '@boardsesh/consent';
import { getConsentSnapshot, isProductAnalyticsGranted, subscribeConsent } from './consent-state';
import { subscribeAnalyticsIdentity } from './analytics-identity-events';

export const AUTH_CONVERSION_WAIT_MS = 2 * 60_000;

/** Preserve an already-consented conversion while its new account authority resolves. */
export function createConsentBoundAnalyticsRunner({
  accountId,
  ready,
}: { accountId?: string; ready?: () => boolean } = {}): (capture: () => void) => void {
  const origin = getConsentSnapshot();
  // A later Allow must never replay actions taken before consent.
  if (!origin.loaded || origin.killed || !isAnalyticsGranted(origin.record)) return () => {};
  const pending: Array<() => void> = [];
  let closed = false;
  let unsubscribe = () => {};
  let unsubscribeIdentity = () => {};
  let timer: ReturnType<typeof setTimeout> | undefined;
  const close = () => {
    closed = true;
    pending.length = 0;
    unsubscribe();
    unsubscribeIdentity();
    clearTimeout(timer);
  };
  const isCurrent = () => {
    const current = getConsentSnapshot();
    return (
      current.authEpoch === origin.authEpoch &&
      !current.killed &&
      isAnalyticsGranted(current.record) &&
      (accountId === undefined || current.accountId === null || current.accountId === accountId) &&
      (origin.accountId === null || current.accountId === origin.accountId)
    );
  };
  const flush = () => {
    if (closed) return;
    // This also observes browser-cookie withdrawals before capture.
    const granted = isProductAnalyticsGranted();
    if (!isCurrent()) {
      close();
      return;
    }
    if (!granted || (accountId !== undefined && getConsentSnapshot().accountId !== accountId) || ready?.() === false)
      return;
    while (pending.length > 0 && !closed && isProductAnalyticsGranted() && isCurrent()) pending.shift()?.();
  };
  unsubscribe = subscribeConsent(flush);
  unsubscribeIdentity = subscribeAnalyticsIdentity(flush);
  timer = setTimeout(close, AUTH_CONVERSION_WAIT_MS);
  return (capture) => {
    if (closed) return;
    pending.push(capture);
    flush();
  };
}
