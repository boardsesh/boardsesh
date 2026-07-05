import { useEffect, useRef } from 'react';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';

// Keeps the screen awake while `active`, scoped to a named tag so multiple
// callers (play drawer, wall kiosk) hold independent locks — the screen stays
// awake while any tag is active. Releases on deactivate and on unmount.
export function useKeepAwakeWhile(active: boolean, tag: string): void {
  // Cleanup already releases the lock on every active:true -> false
  // transition, so the initial-mount case (no prior effect to clean up) is
  // the only time an explicit release is needed here.
  const isFirstRender = useRef(true);

  useEffect(() => {
    if (active) {
      activateKeepAwakeAsync(tag).catch(() => {});
    } else if (isFirstRender.current) {
      deactivateKeepAwake(tag).catch(() => {});
    }
    isFirstRender.current = false;

    return () => {
      deactivateKeepAwake(tag).catch(() => {});
    };
  }, [active, tag]);
}
