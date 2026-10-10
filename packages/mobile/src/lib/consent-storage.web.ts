import {
  CONSENT_COOKIE_MAX_AGE_SECONDS,
  CONSENT_COOKIE_NAME,
  parseConsentCookieValue,
  serializeConsentCookieValue,
  type ConsentRecord,
  type PendingConsentDecision,
} from '@boardsesh/consent';
import { getPreference, setPreference, removePreference } from './preference-store';
import { getConsentSnapshot, setBrowserConsentReader, updateConsentState } from './consent-state';

let observedCookie: string | undefined;

export function readConsentCookie(): ConsentRecord | null {
  if (typeof document === 'undefined') return null;
  const prefix = `${CONSENT_COOKIE_NAME}=`;
  const raw = document.cookie
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(prefix))
    ?.slice(prefix.length);
  const record = parseConsentCookieValue(raw);
  if (raw === observedCookie && getConsentSnapshot().loaded) return getConsentSnapshot().record;
  if (raw !== observedCookie) {
    observedCookie = raw;
    if (getConsentSnapshot().loaded)
      updateConsentState({
        record,
        ...(record?.analytics === 'granted' && getConsentSnapshot().accountId !== null
          ? { accountResolved: false, sdkReady: false }
          : {}),
      });
  }
  return record;
}

setBrowserConsentReader(readConsentCookie);
export const readLatestExternalConsent = readConsentCookie;

export async function readLocalConsent(): Promise<ConsentRecord | null> {
  return readConsentCookie();
}

export async function persistLocalConsent(record: ConsentRecord | null): Promise<void> {
  if (typeof document === 'undefined') return;
  const sharedDomain = ['boardsesh.com', 'www.boardsesh.com', 'app.boardsesh.com'].includes(location.hostname);
  document.cookie = `${CONSENT_COOKIE_NAME}=${record ? serializeConsentCookieValue(record) : ''}; Path=/; Max-Age=${record ? CONSENT_COOKIE_MAX_AGE_SECONDS : 0}; SameSite=Lax${sharedDomain ? '; Domain=.boardsesh.com' : ''}${location.protocol === 'https:' ? '; Secure' : ''}`;
  observedCookie = record ? serializeConsentCookieValue(record) : undefined;
}

export function readPendingConsent(accountId: string): Promise<PendingConsentDecision | null> {
  return getPreference<PendingConsentDecision>(`analyticsConsentPending:${accountId}`);
}

export async function persistPendingConsent(accountId: string, pending: PendingConsentDecision | null): Promise<void> {
  const key = `analyticsConsentPending:${accountId}`;
  if (pending) await setPreference(key, pending);
  else await removePreference(key);
}
