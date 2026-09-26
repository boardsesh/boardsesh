import { useEffect, useState } from 'react';
import { getPreference, setPreference } from './preference-store';

const STORAGE_KEY = 'heatmapLegendCaptionViews';

/** The one-line "what the colours mean" caption shows on this many heatmap views, then never again. */
export const HEATMAP_CAPTION_VIEWS = 3;

/**
 * Whether this heatmap view is one of the first three, so the legend adds its
 * one-line explanation. A view is one switch-on: the count moves when `active`
 * turns true, not on every render. A storage failure just hides the caption.
 */
export function useHeatmapFirstRunCaption(active: boolean): boolean {
  const [show, setShow] = useState(false);
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    getPreference<number>(STORAGE_KEY)
      .then((stored) => {
        const seen = typeof stored === 'number' && Number.isFinite(stored) ? stored : 0;
        if (cancelled || seen >= HEATMAP_CAPTION_VIEWS) return;
        setShow(true);
        setPreference(STORAGE_KEY, seen + 1).catch(() => {});
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      setShow(false);
    };
  }, [active]);
  return show;
}
