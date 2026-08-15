import { useCallback, useEffect, useState } from 'react';
import { getMoonboardLightAdjacentHolds, setMoonboardLightAdjacentHolds } from '@/app/lib/user-preferences-db';

/**
 * MoonBoard "V2" BLE feature toggle: also light each active hold's
 * firmware-defined neighbour LED. Persisted in IndexedDB; the setter updates
 * state immediately (before the write settles) so the light-control drawer's
 * switch responds without a round-trip, mirroring `useLedColorOverrides`.
 */
export function useMoonboardLightAdjacentHolds(): [boolean, (next: boolean) => void] {
  const [enabled, setEnabled] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getMoonboardLightAdjacentHolds()
      .then((value) => {
        if (!cancelled) setEnabled(value);
      })
      .catch(() => {
        // getMoonboardLightAdjacentHolds already logs — swallow so React
        // doesn't surface an unhandled rejection in environments without
        // IndexedDB (SSR, private-mode browsers).
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const update = useCallback((next: boolean) => {
    setEnabled(next);
    void setMoonboardLightAdjacentHolds(next);
  }, []);

  return [enabled, update];
}
