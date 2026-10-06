// Remembers the Refine brush size a climber settled on, in screen points.
//
// Per device, via the AsyncStorage preference store, like the add shape
// (`use-spray-add-shape.ts`): it is a habit of the hand and the screen it is
// on (a point is a different share of the wall on a phone and an iPad), not
// something to sync, and losing it costs one drag of the slider.

import { useCallback, useEffect, useState } from 'react';
import { getPreference, setPreference } from '../../lib/preference-store';
import { DEFAULT_REFINE_BRUSH_PT, parseRefineBrushPt } from './spray-refine';

export const SPRAY_REFINE_BRUSH_KEY = 'boardsesh_spray_editor_refine_brush_pt';

export function useSprayRefineBrush(): readonly [number, (screenPt: number) => void] {
  const [screenPt, setScreenPt] = useState(DEFAULT_REFINE_BRUSH_PT);
  // A pick made before the read lands must not be overwritten by it.
  const [picked, setPicked] = useState(false);

  useEffect(() => {
    if (picked) return;
    let cancelled = false;
    void getPreference<number>(SPRAY_REFINE_BRUSH_KEY)
      .then((stored) => {
        if (!cancelled) setScreenPt(parseRefineBrushPt(stored));
      })
      .catch(() => {
        // Unreadable reads as never chosen: the default size.
      });
    return () => {
      cancelled = true;
    };
  }, [picked]);

  const pickScreenPt = useCallback((next: number) => {
    const size = parseRefineBrushPt(next);
    setPicked(true);
    setScreenPt(size);
    void setPreference(SPRAY_REFINE_BRUSH_KEY, size).catch(() => {
      // Kept in memory for this session; the next launch starts on the default.
    });
  }, []);

  return [screenPt, pickScreenPt] as const;
}
