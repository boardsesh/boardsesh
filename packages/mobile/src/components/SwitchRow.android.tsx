// SwitchRow — Android implementation, real Jetpack Compose via
// @expo/ui/jetpack-compose.
//
// A Compose `Row` (label/description Column + Switch) inside its own `Host`. The
// whole row owns the toggle via the `toggleable` modifier (role 'switch'), so a
// tap anywhere flips it and TalkBack reads the row as a switch labelled by its
// text. Expo UI always makes the nested Compose Switch interactive, even when
// its JavaScript callback is omitted, so it uses the same handler for direct
// thumb taps. Compose consumes that child gesture before it reaches the row.
// We bridge the brand on-track colour, plus an explicit label/description
// colour: this Row sits directly in the Host, not inside a Card, so unlike
// carded row text it gets no M3 on-surface content colour from a surrounding
// container and renders black regardless of colorScheme (same class of bug as
// the MoreForm section titles — see that file's sectionTextColor).
//
// One Host per row is intentional for PR-1 (SwitchRow is used one-per-card
// today). PR-2 consolidates whole settings screens into a single Compose list.

import { Host } from '@expo/ui';
import { Row, Column, Text, Switch } from '@expo/ui/jetpack-compose';
import { fillMaxWidth, weight, toggleable, padding, defaultMinSize, alpha } from '@expo/ui/jetpack-compose/modifiers';
import { StyleSheet } from 'react-native';
import { useTheme } from '../providers/theme-provider';
import { switchBrandColors } from '../theme/expo-ui-modifiers';
import { spacing } from '../theme/tokens';
import { makeToggleHandler } from './SwitchRow.logic';
import type { SwitchRowProps } from './SwitchRow.types';

export function SwitchRow({ label, description, value, onValueChange, disabled = false, tint }: SwitchRowProps) {
  const { brandColors, colorScheme, systemColors } = useTheme();
  const handleToggle = makeToggleHandler(onValueChange, disabled);
  // On-track colour: brand accent (purple) by default; the logbook passes amber.
  const switchColors = tint ? { checkedTrackColor: tint } : switchBrandColors(brandColors);

  const rowModifiers = [
    fillMaxWidth(),
    // ≥48dp tap target — the Material minimum touch target (iOS HIG uses 44pt).
    defaultMinSize({ minHeight: 48 }),
    // The row owns the toggle so the whole surface is tappable; omitted when
    // disabled so a tap is a no-op. `toggleable` sits before `padding` so the
    // ripple covers the padded row, not just the content.
    ...(disabled ? [] : [toggleable(value, () => handleToggle(!value), { role: 'switch' as const })]),
    padding(spacing[4], spacing[2], spacing[4], spacing[2]),
  ];

  return (
    // `matchContents={{ vertical: true }}` (NOT the boolean `matchContents`, which
    // sizes to content in BOTH axes): the Host must fill the parent's width so the
    // Row's `fillMaxWidth()` has a bounded width to fill, while height still tracks
    // content. The boolean form collapsed the label Column and jammed the Switch
    // to the left. Mirrors the iOS Host.
    //
    // `colorScheme` pins the Compose MaterialTheme to our in-app Light/Dark
    // toggle, not the OS scheme — else the label goes dark-on-dark when the app
    // runs dark on a light-mode phone (as MoreForm/FilterChipRow/AppMenu do).
    <Host matchContents={{ vertical: true }} colorScheme={colorScheme} style={styles.host}>
      <Row horizontalArrangement="spaceBetween" verticalAlignment="center" modifiers={rowModifiers}>
        <Column modifiers={disabled ? [weight(1), alpha(0.4)] : [weight(1)]}>
          <Text style={{ typography: 'bodyLarge' }} color={systemColors.label as string}>
            {label}
          </Text>
          {description ? (
            // No `alpha()` modifier here: unlike the old default-colour text,
            // `secondaryLabel` is already opaque and chosen to clear WCAG AA
            // on its own (see colors.ts) — compositing it down again would
            // undo that.
            <Text style={{ typography: 'bodySmall' }} color={systemColors.secondaryLabel as string}>
              {description}
            </Text>
          ) : null}
        </Column>
        <Switch
          value={value}
          enabled={!disabled}
          // Direct taps land on the nested Compose control, not the row. Use the
          // emitted value here; row taps still derive the next value above.
          onCheckedChange={handleToggle}
          colors={switchColors}
        />
      </Row>
    </Host>
  );
}

const styles = StyleSheet.create({
  host: {
    width: '100%',
  },
});
