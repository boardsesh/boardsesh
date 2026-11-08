// ComposeHost — the one Host every Android @expo/ui Compose surface renders in.
//
// An unseeded Compose Host builds its MaterialTheme from Android 12+ dynamic
// colour, so every colour a control doesn't set comes from the phone's
// wallpaper: a blue tonal button, a navy switch thumb, a pale-blue chip icon
// (#6919). Seeding the Host from the brand violet makes that fallback scheme a
// violet one, and pinning `colorScheme` keeps it on our in-app Light/Dark
// toggle instead of the OS scheme (else Compose text goes dark-on-dark when the
// app runs dark on a light-mode phone). A seeded palette still tints every
// SURFACE lilac, so `colorOverrides` pins the surface, container, text and
// outline roles to the theme's neutral Graphite ladder: Compose menus, dialogs
// and text fields then match the RN surfaces around them. All of it comes from
// `useTheme()`, so callers can't pass it; `compose-host-discipline.test.ts`
// keeps raw `Host` out of Android component files.

import { Host } from '@expo/ui';
import type { MaterialColors } from '@expo/ui/jetpack-compose';
import { useMemo, type ComponentProps, type ComponentType } from 'react';
import { useTheme } from '../providers/theme-provider';
import { composeSeedColor, composeSurfaceColorOverrides, type ComposeSurfaceRole } from '../theme/expo-ui-modifiers';

export type ComposeHostProps = Omit<ComponentProps<typeof Host>, 'colorScheme' | 'seedColor'>;

// `Pick` fails to compile if the mapper names a role Compose doesn't have.
type ComposeSurfaceOverrides = Partial<Pick<MaterialColors, ComposeSurfaceRole>>;

// On Android `@expo/ui`'s universal Host is the Compose Host (its
// `index.android.js` re-exports it), which also takes `colorOverrides`; the
// universal typings just don't list that Compose-only prop.
const SeededHost: ComponentType<ComponentProps<typeof Host> & { colorOverrides?: ComposeSurfaceOverrides }> = Host;

export function ComposeHost(props: ComposeHostProps) {
  const { brandColors, colorScheme, m3, m3SurfaceContainers } = useTheme();
  // Memoised so the Host sees one object per theme change, not one per render.
  const colorOverrides = useMemo<ComposeSurfaceOverrides>(
    () => composeSurfaceColorOverrides(m3, m3SurfaceContainers, colorScheme),
    [m3, m3SurfaceContainers, colorScheme],
  );
  return (
    <SeededHost
      {...props}
      colorScheme={colorScheme}
      seedColor={composeSeedColor(brandColors)}
      colorOverrides={colorOverrides}
    />
  );
}
