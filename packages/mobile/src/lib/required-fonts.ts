import { loadAsync } from 'expo-font';
import { setDynamicLoadingErrorCallback } from '@react-native-vector-icons/common';
import materialDesignIconsFont from '@react-native-vector-icons/material-design-icons/fonts/MaterialDesignIcons.ttf';

const reportedFontFamilies = new Set<string>();

/** Preload the same family used by the scoped icon pack before first paint. */
export async function loadRequiredFonts(
  onDynamicFontError?: (error: unknown, fontFamily: string) => void,
): Promise<void> {
  if (onDynamicFontError) {
    // The package catches mounting-time load errors internally. Forward them to
    // the app's reporter so an affected device supplies the actual failure.
    setDynamicLoadingErrorCallback(({ error, fontFamily }) => {
      if (reportedFontFamilies.has(fontFamily)) return;
      reportedFontFamilies.add(fontFamily);
      onDynamicFontError(error, fontFamily);
    });
  }
  await loadAsync({ MaterialDesignIcons: materialDesignIconsFont });
}
