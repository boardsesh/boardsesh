import { createContext, useContext } from 'react';

/**
 * The ink a press ripple takes when its caller names no colour: the theme's
 * `onSurface` on the Material variant, so a ripple on the neutral Graphite
 * surfaces is a grey state layer (M3), not a violet wash. `null` keeps the legacy
 * brand-tint ripple: Liquid Glass on Android, and anything rendered outside the
 * ThemeProvider (the root error boundary, unit tests).
 *
 * Its own small context, not a `useTheme()` read, so `PressableSurface` (in
 * every list row) re-renders only when this one string changes, and so the
 * hundreds of tests that stub the theme provider need no new export.
 */
export const NeutralRippleInkContext = createContext<string | null>(null);

/** The neutral ripple ink for the current theme, or `null` for the legacy brand ripple. */
export function useNeutralRippleInk(): string | null {
  return useContext(NeutralRippleInkContext);
}
