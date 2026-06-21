import type { NativeStackNavigationOptions } from 'expo-router';
import { useTheme } from '../providers/theme-provider';
import { selectByVariant } from '../theme/variants';
import { glassStackScreenOptions } from '../theme/navigation';

/**
 * The native-stack `screenOptions` for the active UI variant — one source of truth
 * for the header on pushed / secondary screens (session detail, the playlist list,
 * the settings stack, the about/acknowledgements/scout/licenses screens, …). The
 * five main tab screens hide the native header and render their own in-body chrome
 * (a Material `Appbar` or a glass collapsing header), so this only styles the
 * pushed screens.
 *
 * - **liquidGlass** → `glassStackScreenOptions`, the value **unchanged** (a
 *   transparent blur header that floats over transparent content on iOS; a solid
 *   header on Android, where a transparent one would draw under the status bar).
 *   Liquid Glass stays byte-identical.
 * - **material** → an opaque Material 3 small top app bar: a solid surface that
 *   blends with the screen, an `onSurface` tint, a left-aligned title, flat at rest
 *   (no shadow, no iOS blur). This fixes forced-Material-on-iOS getting a wrong
 *   glass blur header, and gives Material a themed header instead of the bare
 *   Android default.
 *
 * Spread it as a stack's `screenOptions` (inside a `_layout` component) OR into a
 * per-screen `<Stack.Screen options={{ ...useStackScreenOptions(), title }} />`.
 *
 * M3 caveat: a real M3 app bar shifts `surface → surfaceContainer` as content
 * scrolls under it; native-stack can't express that, so the Material header stays
 * flat (see `theme/variants/README.md`). Lives in `src/hooks` (guard-exempt) — it
 * RESOLVES the variant, it isn't a render-body branch. Uses `selectByVariant` over
 * the already-destructured `theme` so it reads the theme once (not twice via
 * `useVariantValue`).
 */
export function useStackScreenOptions(): NativeStackNavigationOptions {
  const { variant, systemColors } = useTheme();
  return selectByVariant<NativeStackNavigationOptions>(variant, {
    liquidGlass: glassStackScreenOptions,
    material: {
      headerLargeTitle: false,
      headerTransparent: false,
      headerShadowVisible: false,
      // Material resolves `systemColors` to plain hex, so the header blends with
      // the screen (M3 at-rest container = `surface`). `as string` narrows the
      // iOS PlatformColor union that never applies on the Material branch.
      headerStyle: { backgroundColor: systemColors.background as string },
      headerTintColor: systemColors.label as string,
      headerTitleAlign: 'left',
      headerBackButtonDisplayMode: 'minimal',
      contentStyle: { backgroundColor: systemColors.background as string },
    },
  });
}
