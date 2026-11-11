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
// collapses the read back to a single call. Tracked as #4128.
//
// Two namespaces means two candidates for "current", and the ORDER above is only
// right while v2 is the newer one. A bundle rolled back past #4127 writes legacy
// alone, so its token refresh lands ahead of v2 and the roll-forward would read a
// stale, already-revoked credential (#5345). Every mutation here therefore stamps
// what it left in each namespace, and the migration reads that stamp to tell a
// stale v2 copy from a fresh one — see secure-store-stamp.ts and
// docs/keychain-namespaces.md.
//
// Every mutation also records its key here so a migration pass running
// concurrently can stand down — see touchedSecureKeys below.

import * as SecureStore from 'expo-secure-store';
import { SECURE_STORE_V2_OPTIONS, SECURE_STORE_WRITE_OPTIONS, USES_V2_NAMESPACE } from './secure-store-options';
import {
  clearNamespaceStamp,
  fingerprintSecureValue,
  writeNamespaceStamp,
  type NamespaceContent,
} from './secure-store-stamp';

/**
 * The value that means "this key is gone" to every reader here.
 *
 * iOS deletion cannot be confirmed from its result — expo-secure-store's
 * deleteValueWithKeyAsync discards all three SecItemDelete statuses and never
 * throws (SecureStoreModule.swift:43-51) — so an item that refuses deletion but
 * still accepts an overwrite is retired by writing this over it instead.
 *
 * The literal is load-bearing and must never change: tombstones written by earlier
 * builds are sitting in real keychains, and a rename would turn every one of them
 * back into a readable value. It reads as auth-specific because sign-out is where
 * it started (#4127); readSecureValue now honours it for every key, so a cleared
 * preference cannot resurface through the legacy fallback either.
 */
export const SECURE_STORE_TOMBSTONE = '__boardsesh_auth_credential_cleared__';

// Keys this process has written or deleted. The migration pass reads it to avoid
// racing the app: migrateKey reads legacy, then writes that value into v2, and a
// store that deletes or rewrites the same key in between would be undone by the
// write that follows — a cleared preference reappearing, or a just-saved one
// reverting to the legacy blob. The auth scope is immune because its pass runs
// inside auth-store's credential mutation queue; nothing plays that role for the
// 16 preference keys, and this set is what does instead.
//
// The handshake is exact, not probabilistic. Each mutation below marks its key
// SYNCHRONOUSLY, before its first await, so the mark is in place by the time the
// mutation's first native call is even enqueued. migrateKey checks after its last
// await and immediately before its write. So either the app got in first and the
// migration sees the mark and stands down, or the app started after the check —
// in which case its native call is queued behind the migration's write on
// expo-modules-core's serial AsyncFunction queue (AsyncFunctionDefinition.swift:20
// creates a plain, non-concurrent DispatchQueue; :161 dispatches every async
// module call onto it) and therefore lands last, which is the outcome we want.
//
// Skipping loses nothing: a key this process wrote went to v2 first, so it is
// already migrated by construction, and a key this process deleted is gone from
// both namespaces with nothing left to copy.
const touchedSecureKeys = new Set<string>();

/** True when this process has written or deleted `key` since launch. */
export function wasSecureKeyTouchedThisProcess(key: string): boolean {
  return touchedSecureKeys.has(key);
}

/** Raised when a value could not be written to any keychain namespace. */
export class SecureStoreWriteError extends Error {
  readonly failures: readonly unknown[];

  constructor(key: string, failures: readonly unknown[]) {
    super(`Failed to write SecureStore key to any namespace: ${key}`);
    this.name = 'SecureStoreWriteError';
    this.failures = failures;
  }
}

/**
 * Read v2, falling back to the pre-migration legacy namespace.
 *
 * A v2 THROW propagates rather than falling through to legacy, and that is
 * deliberate. On a locked device a v2 miss is `errSecItemNotFound` (a null, not
 * a throw), because the item simply is not there yet — so the fallback still
 * runs for every unmigrated key. A v2 throw means the item exists and could not
 * be read, and swallowing that to hand back a stale legacy copy would be worse
 * than surfacing it. It also keeps auth-store's contract intact: a throw becomes
 * `unavailable` in auth-session.ts, a null becomes a real sign-out (#4001).
 *
 * Only `keychainService` distinguishes the namespaces on a lookup;
 * `keychainAccessible` rides along in the shared options constant and is ignored
 * on read and delete (it is applied at insert time — see secure-store-options).
 */
export async function readSecureValue(key: string): Promise<string | null> {
  const v2Value = await SecureStore.getItemAsync(key, SECURE_STORE_V2_OPTIONS);
  // A v2 hit ends the read: it is both the current value and the proof this key
  // already migrated, so the legacy copy is never consulted again. That is the
  // whole fix — the legacy read is the one that rejects on a locked device.
  if (v2Value !== null || !USES_V2_NAMESPACE) return liveValue(v2Value);
  return liveValue(await SecureStore.getItemAsync(key));
}

/** A tombstone reads as absent, in either namespace. */
function liveValue(stored: string | null): string | null {
  return stored === SECURE_STORE_TOMBSTONE ? null : stored;
}

/** Write to v2, then mirror into legacy for rollback safety (best-effort). */
export async function writeSecureValue(key: string, value: string): Promise<void> {
  touchedSecureKeys.add(key);
  await SecureStore.setItemAsync(key, value, SECURE_STORE_V2_OPTIONS);
  if (!USES_V2_NAMESPACE) return;
  const fingerprint = fingerprintSecureValue(value);
  let legacyContent: NamespaceContent;
  try {
    await SecureStore.setItemAsync(key, value, SECURE_STORE_WRITE_OPTIONS);
    legacyContent = fingerprint;
  } catch {
    // Rollback insurance only. The authoritative v2 write already landed, and a
    // stale legacy copy is harmless while readSecureValue prefers v2. The stamp
    // below records legacy as UNKNOWN rather than as this value, which is what
    // stops a later pass from treating the untouched legacy copy as newer.
    legacyContent = undefined;
  }
  await writeNamespaceStamp(key, fingerprint, legacyContent);
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
  touchedSecureKeys.add(key);
  const failures: unknown[] = [];
  const fingerprint = fingerprintSecureValue(value);

  let v2Content: NamespaceContent;
  try {
    await SecureStore.setItemAsync(key, value, SECURE_STORE_V2_OPTIONS);
    v2Content = fingerprint;
  } catch (error) {
    failures.push(error);
    v2Content = undefined;
  }

  if (!USES_V2_NAMESPACE) {
    if (failures.length > 0) throw new SecureStoreWriteError(key, failures);
    return;
  }

  let legacyContent: NamespaceContent;
  try {
    await SecureStore.setItemAsync(key, value, SECURE_STORE_WRITE_OPTIONS);
    legacyContent = fingerprint;
  } catch (error) {
    failures.push(error);
    legacyContent = undefined;
  }

  // Nothing landed, so nothing about the stored state changed and the existing
  // stamp is still the accurate one. Overwriting it with two unknowns would throw
  // away a repair we could otherwise still make.
  if (failures.length === 2) throw new SecureStoreWriteError(key, failures);

  // One landed write is enough: readSecureValue consults v2 first and legacy
  // second, so either copy is reachable. Recording WHICH one landed is what keeps
  // a sign-out tombstone ahead of the live credential a rejected legacy write left
  // in place — an unconfirmed side never out-ranks a confirmed one.
  await writeNamespaceStamp(key, v2Content, legacyContent);
}

/**
 * Delete from both namespaces so a cleared value cannot resurface via fallback.
 *
 * Passes the same options constant the writes use: only `keychainService`
 * selects which item to delete, and off iOS that constant carries no service at
 * all, so the call is byte-for-byte today's single-namespace delete.
 */
export async function deleteSecureValue(key: string): Promise<void> {
  touchedSecureKeys.add(key);
  await SecureStore.deleteItemAsync(key, SECURE_STORE_V2_OPTIONS);
  if (!USES_V2_NAMESPACE) return;
  await SecureStore.deleteItemAsync(key);

  // Confirm by reading, the way clearStoredCredential already does for
  // credentials. A delete that reports nothing and did nothing is
  // indistinguishable from one that worked, and with two namespaces a landed v2
  // delete beside a silently failed legacy one leaves the old value reachable
  // through the read fallback — where the next launch's migrateKey would copy it
  // back into v2 and make it durable.
  let cleared: boolean;
  try {
    cleared = (await readSecureValue(key)) === null;
  } catch {
    // Unreadable is not proof of deletion. Tombstone it; on a keychain this
    // locked the write below rejects too, and nothing is worse off.
    cleared = false;
  }
  if (cleared) {
    await clearNamespaceStamp(key);
    return;
  }

  try {
    // Some keychain failures reject deletion while still permitting an overwrite.
    // Written to whichever namespace accepts it, because a tombstone in legacy
    // alone still shadows nothing while v2 is empty — and readSecureValue treats
    // it as absent in both.
    await writeSecureValueToEitherNamespace(key, SECURE_STORE_TOMBSTONE);
  } catch {
    // Neither namespace accepts a write and neither accepts a delete. Nothing in
    // JS can retire the item; the caller's own read still reports what survived.
    // Callers that must know — sign-out — verify separately and raise their own
    // error (auth-store's AuthCredentialCleanupError).
  }
}
