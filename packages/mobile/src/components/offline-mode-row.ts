import type { TFunction } from 'i18next';
import { setOfflineMode } from '../lib/connectivity/connectivity-store';
import { hapticSelection } from '../lib/haptics';
import type { MoreToggleRow } from './MoreForm.types';

/**
 * The Offline section's first row: the climber's deliberate "use only what's on
 * this phone" switch (issue #4862).
 *
 * Extracted from `app/(tabs)/profile/more.tsx` the same way
 * `buildFeatureFlagRows` and `getDevMetadataSection` were — the More screen
 * hands its model to a platform-split native form that cannot mount under
 * Vitest, and this row's wiring (which `source` the toggle files, that it goes
 * through the store rather than writing the setting behind its back) is exactly
 * the part worth a test.
 *
 * No confirm dialog and no toast on purpose. The connectivity banner appears the
 * instant the store publishes, says "Offline mode is on" and offers "Go online",
 * so a second confirmation would be one more tap between the climber and a
 * choice that is already reversible in one.
 *
 * `setOfflineMode` — not `setSetting` — because the store owns the whole flip:
 * persistence, the `Offline Mode Toggled` event, cancelling the probe ladder,
 * and re-asking the server on the way back. Writing the setting directly would
 * still reach the store (it subscribes), but with no `source` on the event.
 */
export function buildOfflineModeRow(t: TFunction<'common'>, offlineMode: boolean): MoreToggleRow {
  return {
    kind: 'toggle',
    key: 'offlineMode',
    label: t('mobile.more.offline.offlineMode'),
    subtitle: t('mobile.more.offline.offlineModeDescription'),
    value: offlineMode,
    onValueChange: (next) => {
      hapticSelection();
      setOfflineMode(next, 'more');
    },
  };
}
