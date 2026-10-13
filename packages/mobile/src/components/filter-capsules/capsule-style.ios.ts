// The iOS capsule look, lifted from the climbs chip row so every quick-filter row
// shares one style. An active capsule is filled with the brand FILL colour and
// labelled in the on-fill colour (`primaryFill` + `onPrimary`), the same pair the
// Compose FilterChip uses, so every platform lights a filter the same way. The
// text brand colour (`primary`) is a light lavender in dark mode and is not a
// fill (docs/ai-design-guidelines.md, "Brand colours").
//
// Two drawings, picked by `useGlassCapability()` like Button.ios.tsx:
//   iOS 26 Liquid Glass  resting = neutral glass with secondary grey labels,
//                        active = prominent
//                        glass tinted with the fill (`glassProminent`). Not
//                        `bordered` here: on iOS 26 it is a flat thin material,
//                        too see-through.
//   below iOS 26         resting = a neutral bordered capsule (`bordered`, tinted
//                        with the primary label style so it reads grey rather
//                        than the app's violet accent), active = a solid brand
//                        capsule (`borderedProminent`).
// The fallback is explicit because @expo/ui degrades `glass` / `glassProminent`
// to `.automatic` below iOS 26: a plain text button with no fill, where a white
// active label would vanish on a light background.

import {
  buttonStyle,
  controlSize,
  foregroundColor,
  foregroundStyle,
  tint,
  type ModifierConfig,
} from '@expo/ui/swift-ui/modifiers';
import { brandAccentColor, type BrandControlColors } from '../../theme/expo-ui-modifiers';

/** What the capsule look depends on. Build it once per row (`useMemo`). */
export type CapsuleStyleContext = {
  /** `useTheme().brandColors`. */
  brandColors: BrandControlColors;
  /** `useGlassCapability()`: the device draws real iOS 26 Liquid Glass. */
  supportsGlass: boolean;
};

// A bordered button tints both its fill and its label; the primary label style
// keeps a resting capsule neutral.
const NEUTRAL_TINT = tint({ type: 'hierarchical', style: 'primary' });

/** Modifiers for one capsule, resting or active. */
export function capsuleModifiers(
  active: boolean,
  { brandColors, supportsGlass }: CapsuleStyleContext,
): ModifierConfig[] {
  if (active) {
    return [
      buttonStyle(supportsGlass ? 'glassProminent' : 'borderedProminent'),
      controlSize('small'),
      tint(brandAccentColor(brandColors)),
      foregroundColor(brandColors.onPrimary),
    ];
  }
  return supportsGlass
    ? [buttonStyle('glass'), controlSize('small'), foregroundStyle({ type: 'hierarchical', style: 'secondary' })]
    : [buttonStyle('bordered'), controlSize('small'), NEUTRAL_TINT];
}
