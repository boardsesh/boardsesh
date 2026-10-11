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
let pending: Promise<string> | null = null;
let launchFallbackId: string | null = null;

function randomId(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID();
  // RFC 4122 v4 layout from Math.random, for a runtime without crypto.randomUUID.
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (placeholder) => {
    const nibble = Math.floor(Math.random() * 16);
    return (placeholder === 'x' ? nibble : (nibble & 0x3) | 0x8).toString(16);
  });
}

async function loadOrCreate(): Promise<string> {
  const stored = await getPreference<unknown>(ANONYMOUS_INSTALL_ID_KEY);
  if (typeof stored === 'string' && UUID_PATTERN.test(stored)) return stored;
  const created = randomId();
  await setPreference(ANONYMOUS_INSTALL_ID_KEY, created);
  return created;
}

/**
 * The install's id. Never rejects: when storage cannot be read (iOS before
 * first unlock on a background launch) it returns a launch-only id without
 * caching it, and the next call tries storage again.
 */
export function getAnonymousInstallId(): Promise<string> {
  if (storedId) return Promise.resolve(storedId);
  pending ??= loadOrCreate()
    .then((id) => {
      storedId = id;
      return id;
    })
    .catch(() => {
      launchFallbackId ??= randomId();
      return launchFallbackId;
    })
    .finally(() => {
      pending = null;
    });
  return pending;
}

/** The distinct id a signed-out flag request uses. */
export async function getFlagsInstallDistinctId(): Promise<string> {
  return `flags-install:${await getAnonymousInstallId()}`;
}

/** Test-only: forget the cached id so a test can start from empty storage. */
export function resetAnonymousInstallIdForTests(): void {
  storedId = null;
  pending = null;
  launchFallbackId = null;
}
