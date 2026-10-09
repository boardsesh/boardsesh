import { CONSENT_VERSION, isAnalyticsConsentChoice, isConsentSource, type ConsentRecord } from '@boardsesh/consent';
import { getPreference, setPreference, removePreference } from './preference-store';
import type { PendingConsentDecision } from '@boardsesh/consent';
import { getConsentSnapshot } from './consent-state';

const CONSENT_KEY = 'analyticsConsent';
export function readLatestExternalConsent(): ConsentRecord | null {
  return getConsentSnapshot().record;
}

export async function readLocalConsent(): Promise<ConsentRecord | null> {
  const candidate = await getPreference<unknown>(CONSENT_KEY);
  if (!candidate || typeof candidate !== 'object') return null;
  const record = candidate as Record<string, unknown>;
  if (!isAnalyticsConsentChoice(record.analytics) || !isConsentSource(record.source)) return null;
  if (typeof record.version !== 'number' || !Number.isInteger(record.version) || record.version < CONSENT_VERSION)
    return null;
  if (typeof record.decidedAt !== 'string' || !Number.isFinite(Date.parse(record.decidedAt))) return null;
  return record as ConsentRecord;
}

let localWrites: Promise<void> = Promise.resolve();
export function persistLocalConsent(record: ConsentRecord | null): Promise<void> {
  localWrites = localWrites.catch(() => {}).then(() => writeLocalConsent(record));
  return localWrites;
}

async function writeLocalConsent(record: ConsentRecord | null): Promise<void> {
  if (record) await setPreference(CONSENT_KEY, record);
  else await removePreference(CONSENT_KEY);
}

export function readPendingConsent(accountId: string): Promise<PendingConsentDecision | null> {
  return getPreference<PendingConsentDecision>(`analyticsConsentPending:${accountId}`);
}

export async function persistPendingConsent(accountId: string, pending: PendingConsentDecision | null): Promise<void> {
  const key = `analyticsConsentPending:${accountId}`;
  if (pending) await setPreference(key, pending);
  else await removePreference(key);
}
