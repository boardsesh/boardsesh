import { useEffect } from 'react';
import { setOfflineEngineEnabled } from '../lib/offline-engine';
import { registerSuperProperties } from '../lib/analytics';

export function OfflineEngineFlagSync(): null {
  useEffect(() => {
    setOfflineEngineEnabled(false);
    // Expo web has no offline engine at all, regardless of the flag. Tag it so
    // an `offline_engine_state` breakdown never quietly folds browser sessions
    // into one of the native buckets.
    registerSuperProperties({ offline_engine_state: 'web-off' });
  }, []);
  return null;
}

export function OfflineSyncBridge(): null {
  return null;
}
