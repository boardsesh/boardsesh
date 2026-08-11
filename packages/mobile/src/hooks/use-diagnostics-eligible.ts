import { useEffect, useState } from 'react';
import { isPreviewBuild } from '../lib/preview-build';
import { getPreference } from '../lib/preference-store';
import { OTA_CHANNEL_OVERRIDE_KEY } from '../lib/channel-switch';

/**
 * Whether this session may surface tester diagnostics at all — the on-screen
 * geometry overlays and the settings rows that flip them.
 *
 * True for a dev build, an EAS preview build, or a production install that has
 * switched onto a `pr-<N>` OTA channel. Regular production users see neither the
 * toggle nor the overlay, so a diagnostic can ship OTA without adding surface
 * for everyone.
 *
 * Shared by the bottom-chrome overlay (`BottomChromeDebugOverlay`) and the sheet
 * detent readout (`SheetDetentReadoutOverlay`, #3922).
 */
export function useDiagnosticsEligible(): boolean {
  const [hasPrChannelOverride, setHasPrChannelOverride] = useState(false);
  useEffect(() => {
    if (__DEV__ || isPreviewBuild()) return;
    let cancelled = false;
    getPreference<string>(OTA_CHANNEL_OVERRIDE_KEY)
      .then((storedChannel) => {
        if (!cancelled && storedChannel !== null && storedChannel.startsWith('pr-')) {
          setHasPrChannelOverride(true);
        }
      })
      // Best-effort mirror read (see preference-store.ts on rejections): a failed
      // read just leaves the diagnostics hidden for this launch.
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);
  return __DEV__ || isPreviewBuild() || hasPrChannelOverride;
}
