// Namespace-aware SecureStore access. Every non-excluded SecureStore key in the
// app goes through these helpers so the v2 migration (#4103) has exactly one
// read path and one delete path to reason about, and two write paths that
// differ only in how hard they insist on the v2 namespace.
//
// Phase 1 (this release) runs both namespaces at once:
//   read           — v2 first, legacy as fallback
//   write          — v2 (authoritative), then mirror to legacy best-effort
//   write-to-either — v2 and legacy independently; fails only if both reject
//   delete         — both, so nothing outlives a clear
//
// The mirror is what makes an OTA rollback safe: JS that predates this change
// only knows the legacy namespace, and would sign a user out if their current
// token existed solely in v2. It is deliberately best-effort — mirroring into a
// legacy item that is still WHEN_UNLOCKED throws on a locked device, and that
// must never fail the real (v2) write which just succeeded.
//
// Phase 2, once this has soaked, drops the mirror, deletes the legacy copies and
// collapses the read back to a single call. Tracked as the follow-up issue on the
// #4103 PR.

import * as SecureStore from 'expo-secure-store';
import { SECURE_STORE_V2_OPTIONS, SECURE_STORE_WRITE_OPTIONS, USES_V2_NAMESPACE } from './secure-store-options';

/** Raised when a value could not be written to any keychain namespace. */
export class SecureStoreWriteError extends Error {
  readonly failures: readonly unknown[];

  constructor(key: string, failures: readonly unknown[]) {
    super(`Failed to write SecureStore key to any namespace: ${key}`);
    this.name = 'SecureStoreWriteError';
    this.failures = failures;
  }
}

/** Read v2, falling back to the pre-migration legacy namespace. */
export async function readSecureValue(key: string): Promise<string | null> {
  const v2Value = await SecureStore.getItemAsync(key, SECURE_STORE_V2_OPTIONS);
  // A v2 hit ends the read: it is both the current value and the proof this key
  // already migrated, so the legacy copy is never consulted again. That is the
  // whole fix — the legacy read is the one that rejects on a locked device.
  if (v2Value !== null || !USES_V2_NAMESPACE) return v2Value;
  return SecureStore.getItemAsync(key);
}

/** Write to v2, then mirror into legacy for rollback safety (best-effort). */
export async function writeSecureValue(key: string, value: string): Promise<void> {
  await SecureStore.setItemAsync(key, value, SECURE_STORE_V2_OPTIONS);
  if (!USES_V2_NAMESPACE) return;
  try {
    await SecureStore.setItemAsync(key, value, SECURE_STORE_WRITE_OPTIONS);
  } catch {
    // Rollback insurance only. The authoritative v2 write already landed, and a
    // stale legacy copy is harmless while readSecureValue prefers v2.
  }
}

/**
 * Write to whichever namespace will accept the value, failing only when BOTH
 * reject.
 *
 * Deliberately weaker than writeSecureValue, which must fail loudly when the
 * authoritative v2 write fails because writeCredentialForGeneration returns a
 * boolean the sign-in flow trusts. This writer exists for the sign-out
 * tombstone, where the goal is the opposite: the tombstone shadows a credential
 * that physical deletion could not remove, so landing it in EITHER namespace is
 * strictly better than landing it in neither. Requiring v2 there would let a
 * rejected v2 write skip the legacy mirror and leave the original credential
 * readable through readSecureValue's fallback.
 */
export async function writeSecureValueToEitherNamespace(key: string, value: string): Promise<void> {
  const failures: unknown[] = [];

  try {
    await SecureStore.setItemAsync(key, value, SECURE_STORE_V2_OPTIONS);
  } catch (error) {
    failures.push(error);
  }

  if (!USES_V2_NAMESPACE) {
    if (failures.length > 0) throw new SecureStoreWriteError(key, failures);
    return;
  }

  try {
    await SecureStore.setItemAsync(key, value, SECURE_STORE_WRITE_OPTIONS);
  } catch (error) {
    failures.push(error);
  }

  // One landed write is enough: readSecureValue consults v2 first and legacy
  // second, so either copy is reachable.
  if (failures.length === 2) throw new SecureStoreWriteError(key, failures);
}

/** Delete from both namespaces so a cleared value cannot resurface via fallback. */
export async function deleteSecureValue(key: string): Promise<void> {
  await SecureStore.deleteItemAsync(key, SECURE_STORE_V2_OPTIONS);
  if (USES_V2_NAMESPACE) await SecureStore.deleteItemAsync(key);
}
