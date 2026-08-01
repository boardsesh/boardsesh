// Migrates the non-credential SecureStore keys into the v2 keychain namespace
// (#4103) once per launch, off the render path. The three auth keys do NOT come
// through here — auth-store drives those from its own first read, so they are
// migrated before AuthProvider decides whether to render anything.
//
// Mounted next to InstallReferrerTracker and shaped the same way: fire-and-forget
// after mount, renders nothing, never blocks the splash or the auth gate. There
// is no foreground gate: nothing here is destructive, so a background launch
// either migrates a key or reports it as retry-next-launch, and the v2 item
// itself records which.
//
// This can only ever help the NEXT launch for values read during module eval or
// early render — by the time any component effect runs, the whole module graph
// has already been evaluated. That is inherent to a JS-level fix.

import { useEffect } from 'react';
import { createOnceRunner, migrateSecureKeysToV2 } from '../lib/keychain-namespace-migration';
import { PREFERENCE_SECURE_KEYS } from '../lib/preference-secure-keys';

const migratePreferenceKeys = createOnceRunner(async () => {
  await migrateSecureKeysToV2(PREFERENCE_SECURE_KEYS, 'preferences');
});

export function KeychainNamespaceMigration(): null {
  useEffect(() => {
    void migratePreferenceKeys().catch(() => undefined);
  }, []);

  return null;
}
