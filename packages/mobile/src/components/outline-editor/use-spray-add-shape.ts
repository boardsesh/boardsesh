// Remembers how a climber likes to outline a missed hold: Draw round it, or tap
// its Corners.
//
// Per device, via the AsyncStorage preference store: it is a habit of the hand
// holding the phone, not something to sync, and losing it costs one tap on the
// toggle. Draw is the default because a single tap in Draw still drops a circle,
// which is the quickest way to add the common round hold.

import { useCallback, useEffect, useState } from 'react';
import { getPreference, setPreference } from '../../lib/preference-store';

export type SprayAddShape = 'draw' | 'corners';

export const SPRAY_ADD_SHAPE_KEY = 'boardsesh_spray_editor_add_shape';

export const DEFAULT_SPRAY_ADD_SHAPE: SprayAddShape = 'draw';

/** A stored value read back as a shape, or the default for anything else. */
export function parseSprayAddShape(stored: unknown): SprayAddShape {
  return stored === 'corners' || stored === 'draw' ? stored : DEFAULT_SPRAY_ADD_SHAPE;
}

export function useSprayAddShape(): readonly [SprayAddShape, (shape: SprayAddShape) => void] {
  const [shape, setShape] = useState<SprayAddShape>(DEFAULT_SPRAY_ADD_SHAPE);
  // A pick made before the read lands must not be overwritten by it.
  const [picked, setPicked] = useState(false);

  useEffect(() => {
    if (picked) return;
    let cancelled = false;
    void getPreference<string>(SPRAY_ADD_SHAPE_KEY)
      .then((stored) => {
        if (!cancelled) setShape(parseSprayAddShape(stored));
      })
      .catch(() => {
        // Unreadable reads as never chosen: Draw.
      });
    return () => {
      cancelled = true;
    };
  }, [picked]);

  const pickShape = useCallback((next: SprayAddShape) => {
    setPicked(true);
    setShape(next);
    void setPreference(SPRAY_ADD_SHAPE_KEY, next).catch(() => {
      // Kept in memory for this session; the next launch starts on Draw.
    });
  }, []);

  return [shape, pickShape] as const;
}
