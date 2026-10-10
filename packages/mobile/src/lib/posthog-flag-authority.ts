import { getConsentSnapshot, subscribeConsent } from './consent-state';
import { PostHogPersistedProperty, type PostHog } from 'posthog-react-native';

type FlagAuthority = {
  accountId: string | null;
  consentAccountId: string | null;
  authSettled: boolean;
  authEpoch: number;
  generation: number;
};
let selectedAccountId: string | null = null;
let generation = 0;
let freshResponse: { authority: FlagAuthority; requestId: string } | null = null;
const listeners = new Set<() => void>();

export function getPosthogFlagAuthority(): FlagAuthority {
  const consent = getConsentSnapshot();
  return {
    accountId: consent.authSettled && consent.accountId === selectedAccountId ? selectedAccountId : null,
    consentAccountId: consent.accountId,
    authSettled: consent.authSettled,
    authEpoch: consent.authEpoch,
    generation,
  };
}

export function isPosthogFlagAuthorityCurrent(authority: FlagAuthority): boolean {
  const current = getPosthogFlagAuthority();
  return Object.keys(current).every(
    (key) => current[key as keyof FlagAuthority] === authority[key as keyof FlagAuthority],
  );
}

export function setPosthogFlagAuthority(accountId: string | null): boolean {
  if (selectedAccountId === accountId) return false;
  selectedAccountId = accountId;
  generation++;
  previousAuthority = getPosthogFlagAuthority();
  freshResponse = null;
  listeners.forEach((listener) => listener());
  return true;
}

export function rememberPosthogFlagResponse(authority: FlagAuthority, response: unknown): void {
  if (!isPosthogFlagAuthorityCurrent(authority) || !response || typeof response !== 'object') return;
  const requestId = (response as Record<string, unknown>).requestId;
  if (typeof requestId === 'string') freshResponse = { authority, requestId };
}

/** A cached SDK request id alone cannot prove which account received the answer. */
export function isPosthogFlagResponseCurrent(requestId: string): boolean {
  return (
    freshResponse?.requestId === requestId &&
    freshResponse.authority.authSettled &&
    freshResponse.authority.accountId === freshResponse.authority.consentAccountId &&
    isPosthogFlagAuthorityCurrent(freshResponse.authority)
  );
}

/** Cache ownership and live-response freshness are separate: offline flags are still useful. */
export function isPosthogFlagBagCurrent(client: Pick<PostHog, 'getPersistedProperty'>): boolean {
  const consent = getConsentSnapshot();
  if (typeof client.getPersistedProperty !== 'function') return false;
  const stored = client.getPersistedProperty<Record<string, unknown>>(PostHogPersistedProperty.FeatureFlagDetails);
  if (!stored || !consent.authSettled) return false;
  // An identified SDK can still hold an anonymous or previous-account response.
  // Pre-consent caches lack proof of ownership and wait for a new response.
  return 'boardseshFlagAccountId' in stored && stored.boardseshFlagAccountId === consent.accountId;
}

/** Undefined means a previously accepted response became stale before the SDK persisted it. */
export function ownedPosthogFlagDetails(
  candidate: Record<string, unknown>,
  previous: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (typeof candidate.requestId === 'string') {
    if (!isPosthogFlagResponseCurrent(candidate.requestId)) return undefined;
    return { ...candidate, boardseshFlagAccountId: getPosthogFlagAuthority().accountId };
  }
  // The SDK re-emits its retained bag on errors, with no request id. Preserve
  // its owner but never promote that cached answer to fresh response evidence.
  return previous && 'boardseshFlagAccountId' in previous
    ? { ...candidate, boardseshFlagAccountId: previous.boardseshFlagAccountId }
    : candidate;
}

export function subscribePosthogFlagAuthority(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

let previousAuthority = getPosthogFlagAuthority();
subscribeConsent(() => {
  if (isPosthogFlagAuthorityCurrent(previousAuthority)) return;
  previousAuthority = getPosthogFlagAuthority();
  freshResponse = null;
  listeners.forEach((listener) => listener());
});

const FUNCTIONAL_FLAG_PROPERTY_NAMES = new Set([
  '$os_name',
  '$os_version',
  '$app_version',
  '$app_build',
  '$app_namespace',
  '$device_type',
]);

/** Keep build/platform targeting available without account traits or device identity. */
export function functionalFlagProperties(candidate: unknown): Record<string, string | number | boolean> {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return {};
  const properties: Record<string, string | number | boolean> = {};
  for (const [name, property] of Object.entries(candidate)) {
    if (
      FUNCTIONAL_FLAG_PROPERTY_NAMES.has(name) &&
      (typeof property === 'string' || typeof property === 'number' || typeof property === 'boolean')
    )
      properties[name] = property;
  }
  return properties;
}
