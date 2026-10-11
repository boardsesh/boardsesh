import {
  CONSENT_VERSION,
  isAnalyticsConsentChoice,
  isConsentSource,
  isRegionDefaultConsent,
  type DeviceConsentRecord,
} from '@boardsesh/consent';
import { getPreference, setPreference, removePreference } from './preference-store';
import type { PendingConsentDecision } from '@boardsesh/consent';
import { getConsentSnapshot } from './consent-state';

/**
 * The climber's own answer. Every bundle ever shipped reads this key and treats
 * what it finds as an explicit answer that may be written to the account.
 */
const CONSENT_KEY = 'analyticsConsent';
/**
 * The region default lives under its own key, which bundles that predate it
 * never read. One of those can still run on this device (expo-updates falls
 * back to the embedded bundle, or an OTA is rolled back): it then finds no
 * answer and asks, rather than reading the default as an Allow and writing it
 * to the account. Expand-then-contract, as for the offline database.
 */
export const REGION_DEFAULT_CONSENT_KEY = 'analyticsConsentRegionDefault';

export function readLatestExternalConsent(): DeviceConsentRecord | null {
  return getConsentSnapshot().record;
}

/** The fields every stored answer needs, or null. */
function parseStoredAnswer(candidate: unknown): (DeviceConsentRecord & Record<string, unknown>) | null {
  if (!candidate || typeof candidate !== 'object') return null;
  const record = candidate as Record<string, unknown>;
  if (!isAnalyticsConsentChoice(record.analytics) || !isConsentSource(record.source)) return null;
  if (typeof record.version !== 'number' || !Number.isInteger(record.version) || record.version < CONSENT_VERSION)
    return null;
  if (typeof record.decidedAt !== 'string' || !Number.isFinite(Date.parse(record.decidedAt))) return null;
  return record as DeviceConsentRecord & Record<string, unknown>;
}

/**
 * The stored device answer. An answer saved before answers carried an account,
 * or given signed out, reads back with no owner and is never written to an
 * account; neither is a copy adopted from the account (no `basedOnDecidedAt`).
 * The climber's own answer wins over a region default stored beside it.
 */
export async function readLocalConsent(): Promise<DeviceConsentRecord | null> {
  const answer = parseStoredAnswer(await getPreference<unknown>(CONSENT_KEY));
  // Anything else under the answer key (an early preview of this change wrote
  // the region default there) reads as no answer. The gate then looks the
  // region up again, and the next write moves a default to its own key.
  if (answer && (answer.basis === undefined || answer.basis === 'explicit')) return toDeviceAnswer(answer);
  return readRegionDefault();
}

function toDeviceAnswer(record: DeviceConsentRecord & Record<string, unknown>): DeviceConsentRecord {
  const ownerAccountId = typeof record.ownerAccountId === 'string' ? record.ownerAccountId : null;
  const device: DeviceConsentRecord = {
    analytics: record.analytics,
    version: record.version,
    decidedAt: record.decidedAt,
    source: record.source,
    ownerAccountId,
  };
  // Only a signed-in decision the account has not confirmed carries its token.
  const token = record.basedOnDecidedAt;
  if (ownerAccountId !== null && (token === null || (typeof token === 'string' && Number.isFinite(Date.parse(token)))))
    device.basedOnDecidedAt = token;
  return device;
}

/** A region default carries no owner and no token: it is nobody's answer. */
async function readRegionDefault(): Promise<DeviceConsentRecord | null> {
  const record = parseStoredAnswer(await getPreference<unknown>(REGION_DEFAULT_CONSENT_KEY));
  if (!record || record.basis !== 'region_default' || record.analytics !== 'granted') return null;
  return {
    analytics: 'granted',
    version: record.version,
    decidedAt: record.decidedAt,
    source: record.source,
    basis: 'region_default',
  };
}

let localWrites: Promise<void> = Promise.resolve();
export function persistLocalConsent(record: DeviceConsentRecord | null): Promise<void> {
  localWrites = localWrites.catch(() => {}).then(() => writeLocalConsent(record));
  return localWrites;
}

/**
 * Write the new value first, then clear the other key, so a crash in between
 * leaves the climber's own answer readable (it is read first).
 */
async function writeLocalConsent(record: DeviceConsentRecord | null): Promise<void> {
  if (record === null) {
    await removePreference(CONSENT_KEY);
    await removePreference(REGION_DEFAULT_CONSENT_KEY);
  } else if (isRegionDefaultConsent(record)) {
    await setPreference(REGION_DEFAULT_CONSENT_KEY, {
      analytics: 'granted',
      version: record.version,
      decidedAt: record.decidedAt,
      source: record.source,
      basis: 'region_default',
    });
    await removePreference(CONSENT_KEY);
  } else {
    await setPreference(CONSENT_KEY, record);
    await removePreference(REGION_DEFAULT_CONSENT_KEY);
  }
}

export function readPendingConsent(accountId: string): Promise<PendingConsentDecision | null> {
  return getPreference<PendingConsentDecision>(`analyticsConsentPending:${accountId}`);
}

export async function persistPendingConsent(accountId: string, pending: PendingConsentDecision | null): Promise<void> {
  const key = `analyticsConsentPending:${accountId}`;
  if (pending) await setPreference(key, pending);
  else await removePreference(key);
}
