import { useMemo } from 'react';
import { Platform } from 'react-native';
import { useTheme } from '../providers/theme-provider';
import { useIosSheetBackgroundStyle } from './use-ios-sheet-background-style';

/** The ground a native bottom sheet paints, for every platform.
 *
 * iOS defers to `useIosSheetBackgroundStyle`: SwiftUI owns the Apple
 * presentation, and only Material or Reduce Transparency get an opaque colour.
 *
 * Android and web always get the opaque `theme.sheetSurface`. On Android an
 * unset colour is not neutral: `@expo/ui` hands Compose `containerColor`
 * undefined inside a `Host` with no seed colour, so Android 12+ paints the
 * sheet from the phone wallpaper (a blue, green or orange sheet) and older
 * Android paints stock M3 purple, neither of which our text colours were picked
 * against. On web the Gorhom shim would fall back to
 * `systemColors.secondaryBackground`, which off iOS is the same colour, so web
 * looks the same either way. `sheetSurface` is a plain string, which is what
 * `@expo/ui` reads `backgroundColor` as. */
export function useSheetBackgroundStyle(): { backgroundColor: string } | undefined {
  const { sheetSurface } = useTheme();
  const iosBackgroundStyle = useIosSheetBackgroundStyle();
  const solidBackground = useMemo(() => ({ backgroundColor: sheetSurface }), [sheetSurface]);
  return Platform.OS === 'ios' ? iosBackgroundStyle : solidBackground;
}
