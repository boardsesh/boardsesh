import { getPreference, setPreference } from './preference-store';

/**
 * A random id for this install, kept in the app's own preference store
 * (AsyncStorage; IndexedDB in the browser app). It is not a device identifier,
 * never sits in the PostHog SDK's storage, and is never sent next to an account
 * id.
 *
 * Two uses, both without analytics consent (docs/analytics-consent.md, "Legal
 * basis per tracker"):
 *
 * - **Feature flags for a signed-out climber** (`posthog-client.ts`). A
 *   percentage rollout buckets on the flag request's distinct id. A new id per
 *   launch re-rolled the bucket every launch, and switching to the SDK's own
 *   anonymous id on Allow re-rolled it again. One id per install keeps the
 *   bucket from launch to launch and across Allow / No thanks.
 * - **Anonymous OTA health** (`anonymous-ota-health.ts`), as the distinct id of
 *   `OTA Update Status`, so adoption and emergency-launch rates count installs
 *   rather than launches.
 *
 * It ends with the install, and after 13 months at the latest:
 *
 * - The record holds the install time it was minted under
 *   (`Application.getInstallationTimeAsync()`). Android Auto Backup restores
 *   AsyncStorage on a reinstall or a new phone (`allowBackup` defaults to true
 *   in Expo); a restored record names another install time, so a new id is
 *   minted. Where the platform has no install time (the browser app), the
 *   comparison is skipped.
 * - A record older than {@link INSTALL_ID_LIFETIME_MONTHS} months is replaced,
 *   CNIL's ceiling for a tracker that needs no consent.
 *
 * Signed in, flags use the account id instead, so the bucket changes once at
 * sign-in and then follows the account across devices.
 */

const ANONYMOUS_INSTALL_ID_KEY = 'anonymousInstallId';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const INSTALL_ID_LIFETIME_MONTHS = 13;
/** Install times are compared with this much slack for float rounding on iOS. */
const INSTALL_TIME_TOLERANCE_MS = 1000;

/** What is stored: the id, the install time it belongs to, and when it was minted (epoch ms). */
type StoredInstallId = { id: string; installedAt: number | null; createdAt: number };

let storedId: string | null = null;
let pending: Promise<string | null> | null = null;
let launchFallbackId: string | null = null;

function uuidFromBytes(bytes: Uint8Array): string {
  // RFC 4122 version 4 layout.
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * A UUID from a cryptographically secure source, or null when there is none.
 * Never Math.random: a guessable id would let one install's flag bucket and
 * health reports be predicted. Fails closed instead (callers send nothing).
 */
async function secureRandomId(): Promise<string | null> {
  const webCrypto = globalThis.crypto;
  if (typeof webCrypto?.randomUUID === 'function') return webCrypto.randomUUID();
  if (typeof webCrypto?.getRandomValues === 'function')
    return uuidFromBytes(webCrypto.getRandomValues(new Uint8Array(16)));
  try {
    // Loaded on demand: the native module ships in every binary (auth uses it),
    // and test graphs that never reach this line need no native stub.
    const { getRandomBytes } = await import('expo-crypto');
    return uuidFromBytes(getRandomBytes(16));
  } catch {
    return null;
  }
}

/**
 * When this install happened, in epoch ms, or null where the platform cannot
 * say (the browser app's expo-application returns null, which becomes the
 * epoch). Loaded on demand like expo-crypto, so test graphs need no stub.
 */
async function readInstallationTime(): Promise<number | null> {
  try {
    const { getInstallationTimeAsync } = await import('expo-application');
    const installed = (await getInstallationTimeAsync()).getTime();
    return Number.isFinite(installed) && installed > 0 ? installed : null;
  } catch {
    return null;
  }
}

function parseStored(stored: unknown): StoredInstallId | null {
  if (!stored || typeof stored !== 'object') return null;
  const { id, installedAt, createdAt } = stored as Record<string, unknown>;
  if (typeof id !== 'string' || !UUID_PATTERN.test(id)) return null;
  if (typeof createdAt !== 'number' || !Number.isFinite(createdAt)) return null;
  if (installedAt !== null && (typeof installedAt !== 'number' || !Number.isFinite(installedAt))) return null;
  return { id, installedAt, createdAt };
}

function expiresAt(createdAt: number): number {
  const expiry = new Date(createdAt);
  expiry.setUTCMonth(expiry.getUTCMonth() + INSTALL_ID_LIFETIME_MONTHS);
  return expiry.getTime();
}

/** Still this install's id: same install time (where both are known) and not past its lifetime. */
function isCurrent(record: StoredInstallId, installedAt: number | null, now: number): boolean {
  if (now >= expiresAt(record.createdAt)) return false;
  if (record.installedAt === null || installedAt === null) return true;
  return Math.abs(record.installedAt - installedAt) < INSTALL_TIME_TOLERANCE_MS;
}

async function loadOrCreate(): Promise<string | null> {
  const [stored, installedAt] = await Promise.all([
    getPreference<unknown>(ANONYMOUS_INSTALL_ID_KEY),
    readInstallationTime(),
  ]);
  const now = Date.now();
  const record = parseStored(stored);
  if (record && isCurrent(record, installedAt, now)) return record.id;
  const created = await secureRandomId();
  if (!created) return null;
  const replacement: StoredInstallId = { id: created, installedAt, createdAt: now };
  await setPreference(ANONYMOUS_INSTALL_ID_KEY, replacement);
  return created;
}

/**
 * The install's id, or null when no secure random source exists (fail closed:
 * no flag request, no health report). Never rejects: when storage cannot be
 * read (iOS before first unlock on a background launch) it returns a
 * launch-only id without caching it, and the next call tries storage again.
 */
export function getAnonymousInstallId(): Promise<string | null> {
  if (storedId) return Promise.resolve(storedId);
  pending ??= loadOrCreate()
    .then((id) => {
      storedId = id;
      return id;
    })
    .catch(async () => {
      launchFallbackId ??= await secureRandomId();
      return launchFallbackId;
    })
    .finally(() => {
      pending = null;
    });
  return pending;
}

/** Install-level telemetry requires persistence; a launch fallback is never an install. */
export async function getPersistentAnonymousInstallId(): Promise<string | null> {
  await getAnonymousInstallId();
  return storedId;
}

/** The distinct id a signed-out flag request uses, or null (see getAnonymousInstallId). */
export async function getFlagsInstallDistinctId(): Promise<string | null> {
  const id = await getAnonymousInstallId();
  return id ? `flags-install:${id}` : null;
}

/** Test-only: forget the cached id so a test can start from empty storage. */
export function resetAnonymousInstallIdForTests(): void {
  storedId = null;
  pending = null;
  launchFallbackId = null;
}
