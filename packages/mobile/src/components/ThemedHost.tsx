// ThemedHost — the only `@expo/ui` `Host` the app mounts.
//
// A bare `<Host>` themes its native subtree from the DEVICE colour scheme, not
// ours. On Android that happens twice over:
//
//   - JS: `@expo/ui/src/jetpack-compose/Host` reads react-native's
//     `useColorScheme()` and publishes the resulting M3 palette to descendants
//     through `HostPaletteContext` (a null scheme collapses to 'light').
//   - Native: `HostView.kt` falls back to `isSystemInDarkTheme()`, which reads
//     `resources.configuration.uiMode`.
//
// Neither follows `themeOverride`, because `Appearance.setColorScheme` does not
// reach them on Android (see the comment on `useAppColorScheme`). So a user
// running the app's Dark theme on a light-mode phone got a light Compose theme —
// near-black `onSurface` text — inside RN views painted `#15101E`. That shipped
// once already as issue #3885, and again as the black settings/auth text this
// component fixes.
//
// Passing `colorScheme` is a one-word fix that is trivially forgotten, so the
// bare `Host` import is lint-banned (`no-restricted-imports`, packages/mobile)
// and everything routes through here instead. Callers may still pass an explicit
// `colorScheme` to pin a subtree (the pre-provider crash screen does).

// This file is the one place allowed to import `Host` directly — `.oxlintrc.json`
// exempts it from the `no-restricted-imports` rule that points everyone else here.
import { Host, type UniversalHostProps } from '@expo/ui';
import { useAppColorScheme } from '../providers/theme-provider';

export type ThemedHostProps = UniversalHostProps;

export function ThemedHost({ colorScheme, ...props }: ThemedHostProps) {
  // The app-resolved scheme, which honours the in-app Light/Dark override —
  // deliberately not react-native's `useColorScheme()`.
  const appColorScheme = useAppColorScheme();
  return <Host colorScheme={colorScheme ?? appColorScheme} {...props} />;
}
