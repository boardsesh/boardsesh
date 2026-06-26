// The flag-gated "hide the queue-only bar on social tabs" predicate. Its own
// module so the eyebrow hooks stay free of expo-router / feature-flag deps.

import { useSegments } from 'expo-router';
import type { AccessoryTier } from '@boardsesh/play-view';
import { isSocialSurface, type Segments } from '../../lib/route-segments';
import { useFeatureFlag } from '../../providers/feature-flags-provider';
import { useAccessoryPresentation } from './use-accessory-presentation';

/**
 * Pure predicate (single source of truth): the queue-only ("up next") bar is
 * hidden on a social/browsing surface when the flag is on. A component that
 * already reads the tier (PersistentQueueBar) calls this directly so it doesn't
 * subscribe to the connection state a second time.
 */
export function shouldHideQueueBarOnSocial(flagEnabled: boolean, tier: AccessoryTier, segments: Segments): boolean {
  return flagEnabled && tier === 'resume' && isSocialSurface(segments);
}

/**
 * Hook form for consumers that don't already hold the tier (useBottomChromeMetrics
 * drops the reserved toolbar space so a hidden bar never strands a blank gap or
 * over-lifts the floating controls on home / profile / discover).
 */
export function useQueueBarHiddenOnSocial(): boolean {
  const segments = useSegments();
  const { tier } = useAccessoryPresentation();
  const flagEnabled = useFeatureFlag('accessory-now-playing') === true;
  return shouldHideQueueBarOnSocial(flagEnabled, tier, segments);
}
