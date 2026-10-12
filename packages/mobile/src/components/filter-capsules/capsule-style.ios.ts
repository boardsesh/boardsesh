// The iOS capsule look, lifted from the climbs chip row so every quick-filter row
// shares one style. Real iOS 26 Liquid Glass: a resting capsule is neutral glass
// (`buttonStyle('glass')`); an active one is prominent glass filled with the
// brand FILL colour and the on-fill label (`primaryFill` + `onPrimary`), the
// same pair the Compose FilterChip uses, so the two platforms light a filter the
// same way. The text brand colour (`primary`) is a light lavender in dark mode
// and is not a fill (docs/ai-design-guidelines.md, "Brand colours").
//
// @expo/ui guards both glass styles with `if #available(iOS 26)`, so they degrade
// gracefully on older iOS. (`bordered` fell back to a flat thin material on iOS
// 26, too see-through.)

import { buttonStyle, controlSize, foregroundColor, tint, type ModifierConfig } from '@expo/ui/swift-ui/modifiers';
import { brandAccentColor, type BrandControlColors } from '../../theme/expo-ui-modifiers';

/** Modifiers for one capsule, resting or active. Pass `useTheme().brandColors`. */
export function capsuleModifiers(active: boolean, brandColors: BrandControlColors): ModifierConfig[] {
  return active
    ? [
        buttonStyle('glassProminent'),
        controlSize('small'),
        tint(brandAccentColor(brandColors)),
        foregroundColor(brandColors.onPrimary),
      ]
    : [buttonStyle('glass'), controlSize('small')];
}
