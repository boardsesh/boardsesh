import { parseAccountCreationReceipt, type AccountCreationReceipt } from '@boardsesh/analytics';
import { getConsentSnapshot, subscribeConsent } from './consent-state';

export type VerifiedAuthResult = { userId: string; accountCreation?: AccountCreationReceipt };

let verifiedAuthResult: VerifiedAuthResult | null = null;
let authEpoch = getConsentSnapshot().authEpoch;
const listeners = new Set<(result: VerifiedAuthResult | null) => void>();

export function getVerifiedAuthResult(): VerifiedAuthResult | null {
  return verifiedAuthResult;
}

export function subscribeVerifiedAuthResult(listener: (result: VerifiedAuthResult | null) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Called only after the auth provider commits a successful credential owner. */
export function commitVerifiedAuthResult(result: VerifiedAuthResult | null): void {
  verifiedAuthResult = result;
  for (const listener of listeners) listener(result);
}

subscribeConsent(() => {
  const currentEpoch = getConsentSnapshot().authEpoch;
  if (authEpoch === currentEpoch) return;
  authEpoch = currentEpoch;
  if (verifiedAuthResult !== null) commitVerifiedAuthResult(null);
});

/** Additive metadata is optional when an older backend still returns only tokens. */
export function parseVerifiedAuthResult(candidate: unknown): VerifiedAuthResult | null {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null;
  const response = candidate as Record<string, unknown>;
  if (typeof response.userId !== 'string' || response.userId.length === 0) return null;
  const receipt = parseAccountCreationReceipt(response.accountCreation);
  return {
    userId: response.userId,
    ...(receipt?.userId === response.userId ? { accountCreation: receipt } : {}),
  };
}
