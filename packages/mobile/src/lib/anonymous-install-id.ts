import { getPreference, setPreference } from './preference-store';

/**
 * A random id for this install, kept in the app's own preference store
 * (AsyncStorage; IndexedDB in the browser app). It is not a device identifier,
 * never sits in the PostHog SDK's storage, and is never sent next to an account
 * id. Uninstalling the app clears it.
 *
 * Two uses, both without analytics consent (docs/analytics-consent.md):
 *
 * - **Feature flags for a signed-out climber** (`posthog-client.ts`). A
 *   percentage rollout buckets on the flag request's distinct id. A new id per
 *   launch re-rolled the bucket every launch, and switching to the SDK's own
 *   anonymous id on Allow re-rolled it again. One id per install keeps the
 *   bucket from launch to launch and across Allow / No thanks.
 * - **Anonymous OTA health** (`anonymous-ota-health.ts`), so adoption and
 *   emergency-launch rates count installs rather than launches.
 *
 * Signed in, flags use the account id instead, so the bucket changes once at
 * sign-in and then follows the account across devices.
 */

const ANONYMOUS_INSTALL_ID_KEY = 'anonymousInstallId';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

async function loadOrCreate(): Promise<string | null> {
  const stored = await getPreference<unknown>(ANONYMOUS_INSTALL_ID_KEY);
  if (typeof stored === 'string' && UUID_PATTERN.test(stored)) return stored;
  const created = await secureRandomId();
  if (!created) return null;
  await setPreference(ANONYMOUS_INSTALL_ID_KEY, created);
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
