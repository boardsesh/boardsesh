import { useMemo, type ReactNode } from 'react';
import { Platform } from 'react-native';
import { ThemeProvider as NavigationThemeProvider, DarkTheme, DefaultTheme } from 'expo-router';
import { SystemBars } from 'react-native-edge-to-edge';
import { useTheme } from './theme-provider';
import { iosDarkColors } from '../theme/ios-colors';

// Dark-aware navigation theme so screen/scene backgrounds adapt — without it,
// React Navigation's light-grey DefaultTheme background shows through every
// screen in dark mode. Reads the *resolved* scheme from useTheme() (which
// honours the appearance override) rather than a separate useColorScheme(), so
// the nav chrome and the app theme can't disagree for a frame.
//
// `primary` is the label colour, not React Navigation's iOS blue: it is the tint
// a native header falls back to when its screen sets no `headerTintColor`, so
// without this every such header draws a blue back chevron and blue bar items.
// The brand colour is for the prominent confirm alone (docs/design/mobile-chrome.md,
// "Top-bar buttons"); `useStackScreenOptions` sets the same tint explicitly.
//
// The dark `background` is the scene ground every stack paints under its
// transparent content. On iOS Liquid Glass it is the `systemBackground`
// PlatformColor (the theme's plain page), not a static #000: UIKit resolves it per
// view, so a scene in a sheet takes the elevated #1C1C1E and the cards on it read
// as cards, while a full-screen scene stays #000. React Navigation only paints
// with it (scene and container `backgroundColor`, which processColor resolves);
// it never runs colour math on `background`. Android and Material keep the
// static value.
export function ThemedNavigation({ children }: { children: ReactNode }) {
  const { colorScheme, systemColors, surfaces, variant } = useTheme();
  // The theme's own label colour (an iOS PlatformColor, a hex on Android), so
  // the fallback tint follows the in-app appearance like the rest of the chrome.
  // Typed `string` by React Navigation; react-native-screens hands it to UIKit
  // through processColor, which takes the PlatformColor too.
  const labelTint = systemColors.label as unknown as string;
  // Typed `string` like the tint above, and handed to the native views the same way.
  const darkPageGround =
    Platform.OS === 'ios' && variant === 'liquidGlass'
      ? (surfaces.plain.page as unknown as string)
      : iosDarkColors.background;
  const navTheme = useMemo(
    () =>
      colorScheme === 'dark'
        ? {
            ...DarkTheme,
            colors: {
              ...DarkTheme.colors,
              primary: labelTint,
              background: darkPageGround,
              card: iosDarkColors.secondaryBackground,
            },
          }
        : { ...DefaultTheme, colors: { ...DefaultTheme.colors, primary: labelTint } },
    [colorScheme, labelTint, darkPageGround],
  );
  return (
    <NavigationThemeProvider value={navTheme}>
      {/* Drive BOTH the status-bar and the Android 3-button navigation-bar icon
          contrast from the *resolved* scheme (honours the in-app appearance
          override), not "auto" — under Android's mandatory edge-to-edge the bars
          are transparent over app content, so a forced dark theme on a light OS
          must still get light icons. SystemBars (react-native-edge-to-edge)
          replaces expo-status-bar and also owns the nav-bar tint; a single string
          style applies to both bars. */}
      <SystemBars style={colorScheme === 'dark' ? 'light' : 'dark'} />
      {children}
    </NavigationThemeProvider>
  );
}
