// Migrates the non-credential SecureStore keys into the v2 keychain namespace
// (#4103), off the render path. The three auth keys do NOT come through here —
// auth-store drives those from its own first read, so they are migrated before
// AuthProvider decides whether to render anything.
//
// Mounted next to InstallReferrerTracker and shaped the same way: fire-and-forget
// after mount, renders nothing, never blocks the splash or the auth gate. There
// is no foreground gate, because a background launch can only ever copy a key
// forward or report it as retry-later, and the v2 item itself records which. The
// one way a pass could change what a user sees is by racing a store that clears
// or rewrites the same key mid-copy; migrateKey stands down on any key this
// process has already written or deleted, so that cannot happen.
//
// A pass that did not complete does not latch, and this component re-runs it on
// AppState `active`. The case that matters is a process cold-launched in the
// background on a locked phone, where every key comes back legacy-read-failed;
// without the foreground retry those keys would wait for the next cold start.
// Once a pass completes the runner resolves immediately, so this is a no-op in
// the steady state. The auth keys get the same retry for free — auth-provider
// re-runs checkAuth on AppState `active`, which lands in getStoredCredential.
//
// The foreground listener also drives the deferred #5345 reconciles for BOTH
// scopes, including auth's, which is the one thing auth does not get for free: a
// deferred key sits behind a pass that already latched, so nothing on the read path
// would ever pick it up again.
//
// This can only ever help the NEXT launch for values read during module eval or
// early render — by the time any component effect runs, the whole module graph
// has already been evaluated. That is inherent to a JS-level fix.

import { useEffect } from 'react';
import { AppState } from 'react-native';
import { retryDeferredCredentialReconcile } from '../lib/auth-store';
import {
  createOnceRunner,
  deferredReconcileKeys,
  isMigrationComplete,
  migrateSecureKeysToV2,
} from '../lib/keychain-namespace-migration';
import { PREFERENCE_SECURE_KEYS } from '../lib/preference-secure-keys';

const migratePreferenceKeys = createOnceRunner(async () =>
  isMigrationComplete(await migrateSecureKeysToV2(PREFERENCE_SECURE_KEYS, 'preferences')),
);

function runPreferenceKeyMigration(): void {
  void migratePreferenceKeys().catch(() => undefined);
}

// A completed pass can still leave keys unreconciled: a locked legacy namespace
// makes the #5345 freshness check impossible, and those keys come back
// `reconcile-deferred`. Both scopes retry them HERE rather than from their read
// paths, because a foreground transition is the one moment a WHEN_UNLOCKED item
// becomes readable, and retrying on every read would put throwing legacy reads back
// into the steady state of a locked device.
//
// Both calls resolve immediately when nothing is deferred.
function retryDeferredReconciles(): void {
  const deferredPreferenceKeys = deferredReconcileKeys('preferences');
  if (deferredPreferenceKeys.length > 0) {
    void migrateSecureKeysToV2(deferredPreferenceKeys, 'preferences').catch(() => undefined);
  }
  void retryDeferredCredentialReconcile().catch(() => undefined);
}

export function KeychainNamespaceMigration(): null {
  useEffect(() => {
    runPreferenceKeyMigration();
  }, []);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (nextAppState) => {
      if (nextAppState !== 'active') return;
      runPreferenceKeyMigration();
      retryDeferredReconciles();
    });
    return () => subscription.remove();
  }, []);

  return null;
}
