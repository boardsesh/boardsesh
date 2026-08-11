import * as Updates from 'expo-updates';
import { isPreviewBuild } from '../lib/preview-build';
import { readOtaBranch } from '../lib/ota-telemetry';

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
  return __DEV__ || isPreviewBuild() || readOtaBranch(Updates.manifest)?.startsWith('pr-') === true;
}
