// Namespace-aware SecureStore access. Every non-excluded SecureStore key in the
// app goes through these three helpers so the v2 migration (#4103) has exactly
// one read path, one write path, and one delete path to reason about.
//
// Phase 1 (this release) runs both namespaces at once:
//   read   — v2 first, legacy as fallback
//   write  — v2, then mirror to legacy best-effort
//   delete — both, so nothing outlives a clear
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

/** Delete from both namespaces so a cleared value cannot resurface via fallback. */
export async function deleteSecureValue(key: string): Promise<void> {
  await SecureStore.deleteItemAsync(key, SECURE_STORE_V2_OPTIONS);
  if (USES_V2_NAMESPACE) await SecureStore.deleteItemAsync(key);
}
