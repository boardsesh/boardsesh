import { useEffect } from 'react';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';

const WAKE_LOCK_TAG = 'play-drawer';

export function usePlayDrawerWakeLock(isOpen: boolean): void {
  useEffect(() => {
    if (isOpen) {
      activateKeepAwakeAsync(WAKE_LOCK_TAG).catch(() => {});
    } else {
      deactivateKeepAwake(WAKE_LOCK_TAG).catch(() => {});
    }
    return () => {
      deactivateKeepAwake(WAKE_LOCK_TAG).catch(() => {});
    };
  }, [isOpen]);
}
