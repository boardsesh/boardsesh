import { useTheme } from '../providers/theme-provider';
import { useDeviceLayout } from './use-device-layout';

/**
 * Whether the phone two-pane split is on screen: an iPhone window wide enough
 * for the tab content and the player side by side (the iPhone Duo opened in
 * landscape, see `resolvePhoneSplit`), on the NativeTabs shell the split mounts
 * in (`NativeTabletContent`, gated like `useNativeRootHeader`; the iOS half of
 * that gate is already inside `phoneSplit`). The Material variant keeps its JS
 * tab bar and has no split, so it must not send taps to a pane nobody mounted.
 *
 * The one gate every split consumer reads: the pane host, the drawer host's
 * pane-vs-route choice, the floating queue bar and the bottom-chrome reserve.
 * Live, so it follows the fold and rotation; never true on a tablet.
 */
export function usePhoneSplit(): boolean {
  const { phoneSplit } = useDeviceLayout();
  const { variant } = useTheme();
  return phoneSplit && variant === 'liquidGlass';
}
