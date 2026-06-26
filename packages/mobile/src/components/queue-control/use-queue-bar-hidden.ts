// The flag-gated "hide the queue-only bar on social tabs" predicate. Lives in its
// own module (not use-accessory-presentation) so the eyebrow hooks stay free of
// expo-router / feature-flag deps — components that only render the eyebrow don't
// transitively pull the navigation + flag stack into their tests.

import { useSegments } from 'expo-router';
import { isSocialSurface } from '../../lib/route-segments';
import { useFeatureFlag } from '../../providers/feature-flags-provider';
import { useAccessoryPresentation } from './use-accessory-presentation';

/**
 * Whether the queue-only ("up next") bar is hidden on the current social surface
 * (flag-gated). Single source of truth shared by PersistentQueueBar (which then
 * renders nothing) and useBottomChromeMetrics (which then drops the reserved
 * toolbar space), so a hidden bar never strands a blank gap or over-lifts the
 * floating controls on home / profile / discover.
 */
export function useQueueBarHiddenOnSocial(): boolean {
  const segments = useSegments();
  const { tier } = useAccessoryPresentation();
  const flagEnabled = useFeatureFlag('accessory-now-playing') === true;
  return flagEnabled && tier === 'resume' && isSocialSurface(segments);
}
