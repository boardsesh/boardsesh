// One-way copy of SecureStore values from the legacy keychain service into the v2
// service, which is what actually resets kSecAttrAccessible to AFTER_FIRST_UNLOCK
// for items written before #3602 shipped. Background reads on a locked device
// (token refresh, WS reconnect, Live Activity) stop failing once a key is here.
// See secure-store-options.ts for why rewriting in place cannot work.
//
// Per key: read v2 → present means done, unless its namespace stamp says otherwise
// (below). Else read legacy → null means nothing to move. Else write v2 and READ IT
// BACK before calling it migrated.
//
// The "present means done" half was wrong on its own, and #5345 is what it cost: a
// bundle rolled back past #4127 reads and writes the LEGACY namespace only, so its
// token refresh leaves a current credential in legacy and a revoked one in v2. Roll
// forward and the v2 item — still there, still "done" — is the stale copy, which is
// a 401 and a forced sign-out. So a key WITH a v2 item is now reconciled against
// the stamp secure-store-stamp.ts keeps, and repaired from legacy when the stamp
// proves an unaware build wrote legacy last. Everything ambiguous stays
// `already-v2`, and an unstamped key never touches the legacy namespace at all.
//
// Every step is safe to interrupt because nothing is destroyed. A key is either
// legacy-only (retry next launch) or in both namespaces (v2 wins on read) —
// never neither, so there is no window where a credential does not exist and no
// orphan copy that could resurrect a signed-out session. Progress is recorded by
// the v2 item itself, per key, so a partial pass simply resumes: keys that
// aborted still have no v2 item and get retried, while keys that made it are
// skipped by the first read. The stamp is an optimisation on top of that, never a
// completion record: losing it costs a repair, never a migration.
//
// The legacy copy is deliberately NOT deleted here. It is phase 1's rollback
// path: JS that predates this change reads only the legacy namespace, so
// deleting it would strand anyone who lands back on an older bundle between the
// migration and their next token write. Legacy cleanup belongs to phase 2, after
// this has soaked — a leftover legacy copy is inert while readers prefer v2.
//
// Nothing is destroyed, but the copy is not inert either: it is a read of legacy
// followed by a write of that value into v2, and a store that clears or rewrites
// the same key in between would be silently undone by the write. The auth scope
// avoids that by running inside auth-store's credential mutation queue; the 16
// preference keys have no such queue, so migrateKey stands down on any key this
// process has written or deleted (secure-store-io's touched-key registry).
//
// The SecureStore calls here are RAW on purpose: routing them through
// secure-store-io would re-enter the auth read path that awaits this migration.
// The one thing imported from that module is a synchronous predicate, which
// performs no I/O and cannot re-enter anything.

import * as SecureStore from 'expo-secure-store';
import { track } from './analytics';
import { SECURE_STORE_V2_OPTIONS, USES_V2_NAMESPACE } from './secure-store-options';
import { wasSecureKeyTouchedThisProcess } from './secure-store-io';
import {
  fingerprintSecureValue,
  readNamespaceStamp,
  resolveNamespaceVerdict,
  writeNamespaceStamp,
} from './secure-store-stamp';

export type SecureKeyMigrationStatus =
  | 'already-v2'
  | 'migrated'
  | 'repaired'
  | 'absent'
  | 'superseded'
  | 'v2-read-failed'
  | 'legacy-read-failed'
  | 'v2-write-failed'
  | 'verify-mismatch';

export type SecureKeyMigrationOutcome = { key: string; status: SecureKeyMigrationStatus };

// `superseded` sits with the successes because the app's own write already put
// the key in v2 (writeSecureValue writes v2 first), or its delete removed the key
// from both namespaces — either way there is nothing left for a retry to do, and
// treating it as a failure would keep the pass permanently incomplete and hide
// the completion signal phase 2 (#4128) gates on. The one gap is a
// writeSecureValueToEitherNamespace whose v2 half was rejected while legacy
// succeeded, which needs a keychain refusing v2 writes — a device that has not
// been unlocked since boot, where the migration was going to fail anyway. The
// next launch starts with an empty registry and picks it back up.
const SUCCESS_STATUSES: readonly SecureKeyMigrationStatus[] = [
  'already-v2',
  'migrated',
  'repaired',
  'absent',
  'superseded',
];

/**
 * Copy `value` into v2 and confirm it landed, then stamp both namespaces.
 *
 * The read-back is the point: a write that reported no error but did not land
 * would otherwise leave the key looking migrated to this pass while the next
 * launch still reads legacy.
 */
async function copyIntoV2(
  key: string,
  value: string,
  status: 'migrated' | 'repaired',
): Promise<SecureKeyMigrationOutcome> {
  try {
    await SecureStore.setItemAsync(key, value, SECURE_STORE_V2_OPTIONS);
  } catch {
    return { key, status: 'v2-write-failed' };
  }

  let verifiedValue: string | null;
  try {
    verifiedValue = await SecureStore.getItemAsync(key, SECURE_STORE_V2_OPTIONS);
  } catch {
    return { key, status: 'verify-mismatch' };
  }
  if (verifiedValue !== value) return { key, status: 'verify-mismatch' };

  // Both namespaces now hold `value`, and saying so closes the rollback window
  // immediately instead of waiting for the app's next write to open a stamp.
  const fingerprint = fingerprintSecureValue(value);
  await writeNamespaceStamp(key, fingerprint, fingerprint);
  return { key, status };
}

/**
 * Decide whether a key that already has a v2 item is actually up to date (#5345).
 *
 * A v2 item used to be proof on its own, which is wrong after an OTA rollback: JS
 * that predates the v2 namespace refreshes tokens into legacy alone, so v2 can be
 * holding a credential the backend has already revoked. The stamp is what tells the
 * two apart — see secure-store-stamp.ts for the rule and why a bare counter cannot
 * express it.
 *
 * Every uncertainty resolves to `already-v2`, which is byte-for-byte the old
 * behaviour, and the legacy namespace is not touched at all until a stamp exists to
 * compare against — so an unstamped key keeps the zero-legacy-contact read path
 * this migration exists to give locked devices.
 */
async function reconcileExistingV2(key: string, existingV2: string): Promise<SecureKeyMigrationOutcome> {
  const stamp = await readNamespaceStamp(key);
  if (stamp === null) return { key, status: 'already-v2' };

  let legacyValue: string | null;
  try {
    legacyValue = await SecureStore.getItemAsync(key);
  } catch {
    // Locked legacy namespace. We cannot compare, so v2 stands — exactly what
    // happened before this check existed, and not a failure worth retrying.
    return { key, status: 'already-v2' };
  }
  if (legacyValue === null || legacyValue === existingV2) return { key, status: 'already-v2' };
  if (resolveNamespaceVerdict(stamp, existingV2, legacyValue) !== 'legacy-newer') return { key, status: 'already-v2' };

  // Same race, same guard as the copy below: the app writing this key in the
  // window between the legacy read and the v2 write would be undone by it.
  if (wasSecureKeyTouchedThisProcess(key)) return { key, status: 'superseded' };

  return copyIntoV2(key, legacyValue, 'repaired');
}

async function migrateKey(key: string): Promise<SecureKeyMigrationOutcome> {
  let existingV2: string | null;
  try {
    existingV2 = await SecureStore.getItemAsync(key, SECURE_STORE_V2_OPTIONS);
  } catch {
    return { key, status: 'v2-read-failed' };
  }
  if (existingV2 !== null) return reconcileExistingV2(key, existingV2);

  let legacyValue: string | null;
  try {
    legacyValue = await SecureStore.getItemAsync(key);
  } catch {
    // The locked-device case this whole migration exists to fix. Nothing has
    // been touched; the next foreground launch retries.
    return { key, status: 'legacy-read-failed' };
  }
  if (legacyValue === null) return { key, status: 'absent' };

  // Last statement before the write, and deliberately so: the app marks a key
  // synchronously on entry to any write or delete, so a mutation that started at
  // any point since this pass began is visible here. Writing `legacyValue` now
  // would resurrect a preference the user just cleared, or revert one they just
  // saved, because readSecureValue prefers the v2 copy this write would create.
  if (wasSecureKeyTouchedThisProcess(key)) return { key, status: 'superseded' };

  return copyIntoV2(key, legacyValue, 'migrated');
}

/** True when every key in the pass reached a terminal, retry-free state. */
export function isMigrationComplete(outcomes: readonly SecureKeyMigrationOutcome[]): boolean {
  return outcomes.every((outcome) => SUCCESS_STATUSES.includes(outcome.status));
}

// An incomplete pass is retried on the next token read (auth) or the next
// foreground (preferences), and on a locked background wake every one of those
// retries fails identically. Emitting each of them would turn a single stuck
// device into a stream of identical events, so only the first incomplete pass
// per scope is reported. The entry is cleared when the scope completes, so a
// later regression is still visible.
const reportedIncompleteScopes = new Set<string>();

function reportOutcomes(scope: string, outcomes: readonly SecureKeyMigrationOutcome[]): void {
  const failures = outcomes.filter((outcome) => !SUCCESS_STATUSES.includes(outcome.status));
  if (failures.length === 0) {
    reportedIncompleteScopes.delete(scope);
  } else {
    if (reportedIncompleteScopes.has(scope)) return;
    reportedIncompleteScopes.add(scope);
  }
  track('Keychain Namespace Migration', {
    scope,
    keys: outcomes.length,
    migrated: outcomes.filter((outcome) => outcome.status === 'migrated').length,
    // A non-zero count here means devices came back from a rolled-back bundle and
    // had a stale v2 credential repaired instead of being signed out (#5345).
    repaired: outcomes.filter((outcome) => outcome.status === 'repaired').length,
    already_v2: outcomes.filter((outcome) => outcome.status === 'already-v2').length,
    absent: outcomes.filter((outcome) => outcome.status === 'absent').length,
    superseded: outcomes.filter((outcome) => outcome.status === 'superseded').length,
    failed: failures.length,
    // Key names only — never values. Bounded by the fixed key list, and only
    // non-success keys appear, so a healthy pass sends an empty string.
    failures: failures.map((outcome) => `${outcome.key}:${outcome.status}`).join(','),
  });
}

/**
 * Migrate the given keys into the v2 namespace. Resolves with one outcome per
 * key; never rejects, because a per-key failure is a retry-next-launch, not an
 * error the caller can act on. No-op off iOS.
 */
export async function migrateSecureKeysToV2(
  keys: readonly string[],
  scope: string,
): Promise<SecureKeyMigrationOutcome[]> {
  if (!USES_V2_NAMESPACE) return [];

  const outcomes: SecureKeyMigrationOutcome[] = [];
  // Sequential: these are keychain round-trips on a cold start, and the auth
  // scope runs inside the credential mutation queue where ordering matters.
  for (const key of keys) {
    outcomes.push(await migrateKey(key));
  }

  reportOutcomes(scope, outcomes);
  return outcomes;
}

/**
 * Run `task` until it reports completion, at most once at a time, sharing the
 * in-flight promise with concurrent callers.
 *
 * `task` resolves `true` to latch (never run again this process) and `false` to
 * ask for a retry on the next call; a rejection also retries. The boolean is
 * what keeps a background cold launch on a locked phone from burning the single
 * attempt: migrateSecureKeysToV2 never rejects — a locked keychain is an
 * expected outcome it resolves, not an error — so a void task would latch on a
 * pass where every key came back legacy-read-failed and never retry, even after
 * the user unlocks and foregrounds the app. Signalling that with a thrown
 * sentinel would work too, but throwing for a normal, expected outcome is
 * exactly the control flow a later edit "helpfully" deletes.
 *
 * The retry hooks are real: auth re-runs through auth-provider.tsx's AppState
 * `active` -> checkAuth -> getAuthToken path, and preferences re-run from
 * KeychainNamespaceMigration's own AppState listener. The shared in-flight
 * promise is what stops the six near-simultaneous cold-start auth readers from
 * each starting a pass.
 */
export function createOnceRunner(task: () => Promise<boolean>): () => Promise<void> {
  let completed = false;
  let inFlight: Promise<void> | null = null;

  return function runOnce(): Promise<void> {
    if (completed) return Promise.resolve();
    if (inFlight !== null) return inFlight;
    inFlight = task().then(
      (didComplete: boolean) => {
        completed = didComplete;
        inFlight = null;
      },
      (error: unknown) => {
        inFlight = null;
        throw error;
      },
    );
    return inFlight;
  };
}
