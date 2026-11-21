import { useEffect } from 'react';
import { useAuth } from '../providers/auth-provider';
import { useStoredUserId } from '../hooks/use-current-user-id';
import { useSprayCompletionUpdates } from '../notifications/use-spray-completion-updates';
import { setOfflineEngineEnabled } from '../lib/offline-engine';
import { registerOfflineEngineState } from '../lib/analytics-offline-engine-state';

export function OfflineEngineFlagSync(): null {
  useEffect(() => {
    setOfflineEngineEnabled(false);
    // Expo web has no offline engine at all, regardless of the flag. Tag it so
    // an `offline_engine_state` breakdown never quietly folds browser sessions
    // into one of the native buckets.
    registerOfflineEngineState('web-off');
  }, []);
  return null;
}

export function OfflineSyncBridge(): null {
  const { isAuthenticated, isLoading } = useAuth();
  const { userId } = useStoredUserId(isAuthenticated);
  useSprayCompletionUpdates(isAuthenticated && !isLoading, userId);
  return null;
}
