// Single read of the now-playing redesign flag. Its own leaf module (imports only
// the feature-flags provider) so the components that gate on it can mock just this
// in tests without pulling the analytics/expo stack.

import { useFeatureFlag } from '../../providers/feature-flags-provider';

/**
 * Whether the now-playing accessory redesign is enabled. Flag off = the bar
 * behaves exactly as it did before the redesign (no eyebrow, tick always shown,
 * never hidden on social tabs).
 */
export function useAccessoryNowPlayingEnabled(): boolean {
  return useFeatureFlag('accessory-now-playing') === true;
}
