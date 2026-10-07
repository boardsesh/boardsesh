// Remembers which edge of the iPad the spray editor's tool rail lives on.
//
// Per device, via the AsyncStorage preference store, like the add shape: it is
// about the hand that holds the Pencil, not something to sync, and losing it
// costs one drag. Leading is the default.

import { useCallback, useEffect, useState } from 'react';
import { getPreference, setPreference } from '../../lib/preference-store';
import { DEFAULT_SPRAY_RAIL_SIDE, parseSprayRailSide, type SprayRailSide } from './spray-tablet-layout';

export const SPRAY_RAIL_SIDE_KEY = 'boardsesh_spray_editor_rail_side';

export function useSprayRailSide(enabled: boolean): readonly [SprayRailSide, (side: SprayRailSide) => void] {
  const [side, setSide] = useState<SprayRailSide>(DEFAULT_SPRAY_RAIL_SIDE);
  // A drag made before the read lands must not be overwritten by it.
  const [picked, setPicked] = useState(false);

  useEffect(() => {
    if (!enabled || picked) return;
    let cancelled = false;
    void getPreference<string>(SPRAY_RAIL_SIDE_KEY)
      .then((stored) => {
        if (!cancelled) setSide(parseSprayRailSide(stored));
      })
      .catch(() => {
        // Unreadable reads as never moved: leading.
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, picked]);

  const pickSide = useCallback((next: SprayRailSide) => {
    setPicked(true);
    setSide(next);
    void setPreference(SPRAY_RAIL_SIDE_KEY, next).catch(() => {
      // Kept in memory for this session; the next launch starts on the leading edge.
    });
  }, []);

  return [side, pickSide] as const;
}
