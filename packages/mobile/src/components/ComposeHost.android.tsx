// ComposeHost — the one Host every Android @expo/ui Compose surface renders in.
//
// An unseeded Compose Host builds its MaterialTheme from Android 12+ dynamic
// colour, so every colour a control doesn't set comes from the phone's
// wallpaper: a blue tonal button, a navy switch thumb, a pale-blue chip icon
// (#6919). Seeding the Host from the brand violet makes that fallback scheme a
// violet one, and pinning `colorScheme` keeps it on our in-app Light/Dark
// toggle instead of the OS scheme (else Compose text goes dark-on-dark when the
// app runs dark on a light-mode phone). Both come from `useTheme()`, so callers
// can't pass them; `compose-host-discipline.test.ts` keeps raw `Host` out of
// Android component files.

import { Host } from '@expo/ui';
import type { ComponentProps } from 'react';
import { useTheme } from '../providers/theme-provider';
import { composeSeedColor } from '../theme/expo-ui-modifiers';

export type ComposeHostProps = Omit<ComponentProps<typeof Host>, 'colorScheme' | 'seedColor'>;

export function ComposeHost(props: ComposeHostProps) {
  const { brandColors, colorScheme } = useTheme();
  return <Host {...props} colorScheme={colorScheme} seedColor={composeSeedColor(brandColors)} />;
}
