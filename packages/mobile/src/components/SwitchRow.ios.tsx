// SwitchRow — iOS implementation, real SwiftUI via @expo/ui/swift-ui.
//
// A single SwiftUI `Toggle` (the native iOS switch) inside its own `Host`. The
// Label text grows inside SwiftUI so the Host reports the same height the row
// draws. The native Toggle supplies the switch trait and on/off announcement.
//
// One Host per row is intentional for PR-1 (SwitchRow is used one-per-card
// today). PR-2 consolidates whole settings screens into a single SwiftUI Form.

import { Host } from '@expo/ui';
import { Toggle, Text, VStack } from '@expo/ui/swift-ui';
import {
  tint,
  disabled as disabledModifier,
  padding,
  frame,
  fixedSize,
  lineLimit,
  font,
  foregroundStyle,
  accessibilityLabel,
} from '@expo/ui/swift-ui/modifiers';
import { StyleSheet } from 'react-native';
import { useTheme } from '../providers/theme-provider';
import { brandControlTint } from '../theme/expo-ui-modifiers';
import { spacing } from '../theme/tokens';
import { makeToggleHandler } from './SwitchRow.logic';
import type { SwitchRowProps } from './SwitchRow.types';

// matchContents writes the native height directly into Yoga. Put the floor in
// SwiftUI, where it participates in that measurement, rather than on the Host.
// This is a minimum only: wrapped descriptions and Dynamic Type grow the row.
const ROW_MIN_HEIGHT = 48;
const ROW_MIN_HEIGHT_WITH_SUBTITLE = 64;

export function SwitchRow({ label, description, value, onValueChange, disabled = false }: SwitchRowProps) {
  const { brandColors, colorScheme } = useTheme();
  const handleToggle = makeToggleHandler(onValueChange, disabled);
  // On-track colour: the brand control tint (HIG Color: one accent for every
  // control). Not the brand FILL — that one fails 3:1 on a dark grouped card.
  const onTrack = brandControlTint(brandColors);

  return (
    <Host matchContents={{ vertical: true }} colorScheme={colorScheme} ignoreSafeArea="all" style={styles.host}>
      <Toggle
        isOn={value}
        onIsOnChange={handleToggle}
        modifiers={[
          // Inset the row so the trailing switch isn't flush with (and clipped by)
          // the container's right edge — matches the old row's paddingHorizontal
          // and the Android impl's padding.
          padding({ horizontal: spacing[4], vertical: spacing[2] }),
          frame({ minHeight: description ? ROW_MIN_HEIGHT_WITH_SUBTITLE : ROW_MIN_HEIGHT }),
          // On-track colour: the brand tint.
          tint(onTrack),
          // SwiftUI greys the control and blocks interaction natively.
          disabledModifier(disabled),
          // Keep one accessible native switch even though its label is a stack.
          accessibilityLabel(description ? `${label}, ${description}` : label),
        ]}
      >
        <VStack
          alignment="leading"
          spacing={spacing[1]}
          modifiers={[lineLimit(), fixedSize({ horizontal: false, vertical: true })]}
        >
          <Text modifiers={[font({ textStyle: 'body' })]}>{label}</Text>
          {description ? (
            <Text
              modifiers={[
                font({ textStyle: 'subheadline' }),
                foregroundStyle({ type: 'hierarchical', style: 'secondary' }),
              ]}
            >
              {description}
            </Text>
          ) : null}
        </VStack>
      </Toggle>
    </Host>
  );
}

const styles = StyleSheet.create({
  host: {
    width: '100%',
  },
});
