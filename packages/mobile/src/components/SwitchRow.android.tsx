// SwitchRow — Android implementation, real Jetpack Compose via
// @expo/ui/jetpack-compose.
//
// A Compose `Row` (label/description Column + Switch) inside its own `Host`. The
// whole row owns the toggle via the `toggleable` modifier (role 'switch'), so a
// tap anywhere flips it and TalkBack reads the row as a switch labelled by its
// text. The Switch's own `onCheckedChange` is left undefined so the tap fires
// once, not twice. We bridge only the brand on-track colour; M3 surface/label
// colours come from the Compose Material theme the Host sets up.
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
  const { brandColors, colorScheme } = useTheme();
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
    // `colorScheme` forces the Compose MaterialTheme to follow our in-app
    // Light/Dark toggle instead of the OS scheme — without it the label text
    // renders dark-on-dark when the app runs dark on a light-mode device
    // (same fix as MoreForm/FilterChipRow's Hosts).
    <Host matchContents={{ vertical: true }} colorScheme={colorScheme} style={styles.host}>
      <Row horizontalArrangement="spaceBetween" verticalAlignment="center" modifiers={rowModifiers}>
        <Column modifiers={disabled ? [weight(1), alpha(0.4)] : [weight(1)]}>
          <Text style={{ typography: 'bodyLarge' }}>{label}</Text>
          {description ? (
            <Text style={{ typography: 'bodySmall' }} modifiers={[alpha(0.6)]}>
              {description}
            </Text>
          ) : null}
        </Column>
        <Switch
          value={value}
          enabled={!disabled}
          // The row's `toggleable` owns the tap — leave the Switch passive so a
          // tap on it doesn't double-fire the toggle.
          onCheckedChange={undefined}
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
