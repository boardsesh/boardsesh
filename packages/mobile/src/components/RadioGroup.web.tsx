// RadioGroup — web implementation (react-native-web + react-native-paper). A Paper
// `RadioButton.Group` of `RadioButton.Item`s — the Material counterpart to the
// Compose RadioButton group in RadioGroup.android.tsx. Like Android (and unlike the
// iOS inline Picker), the web variant honours the per-option `description` and
// `disabled`. The haptic + disabled guard lives in RadioGroup.logic.ts, shared with
// both native files.

import { StyleSheet, View } from 'react-native';
import { RadioButton, Text } from 'react-native-paper';
import { useTheme } from '../providers/theme-provider';
import { makeRadioSelectHandler } from './RadioGroup.logic';
import type { RadioGroupProps } from './RadioGroup.types';

export function RadioGroup<T extends string>({ options, value, onChange }: RadioGroupProps<T>) {
  const { systemColors } = useTheme();
  const handleSelect = makeRadioSelectHandler(onChange);

  return (
    <RadioButton.Group
      value={value}
      onValueChange={(next) => {
        const option = options.find((candidate) => candidate.value === next);
        if (option) handleSelect(option);
      }}
    >
      {options.map((option) => (
        <View key={option.value}>
          <RadioButton.Item value={option.value} label={option.label} disabled={option.disabled} position="leading" />
          {option.description ? (
            <Text variant="bodySmall" style={[styles.description, { color: systemColors.secondaryLabel as string }]}>
              {option.description}
            </Text>
          ) : null}
        </View>
      ))}
    </RadioButton.Group>
  );
}

const styles = StyleSheet.create({
  description: {
    // Aligns under the label past the leading radio control + its gutter.
    paddingLeft: 56,
    paddingBottom: 8,
    opacity: 0.8,
  },
});
