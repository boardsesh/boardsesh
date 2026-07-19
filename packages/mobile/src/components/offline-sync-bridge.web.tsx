import { useEffect } from 'react';
import { setOfflineEngineEnabled } from '../lib/offline-engine';

export function OfflineEngineFlagSync(): null {
  useEffect(() => {
    setOfflineEngineEnabled(false);
  }, []);
  return null;
}

export function OfflineSyncBridge(): null {
  return null;
}
