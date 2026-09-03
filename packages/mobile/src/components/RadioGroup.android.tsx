// RadioGroup — Android implementation, real Jetpack Compose via
// @expo/ui/jetpack-compose.
//
// A Compose `Column` (marked a `selectableGroup` for TalkBack) of `Row`s, each a
// leading `RadioButton` + a label/description `Column`. The whole row owns the
// selection via the `selectable` modifier (role 'radioButton'), so a tap anywhere
// picks it and TalkBack reads the row as a radio option labelled by its text. The
// RadioButton's own `onClick` is left undefined so the tap fires once, not twice.
// Unlike iOS, Android CAN show the per-option `description` and disable a row, so
// the public API's full fidelity survives here. Brand tint comes from the Compose
// Material theme the Host sets up (RadioButton has no colours prop — it reads M3
// `primary`, which is the brand accent under our theme).
//
// One Host per control is intentional for now (RadioGroup is used one-per-card).

import { useMemo } from 'react';
import { Host } from '@expo/ui';
import { Column, Row, Text, RadioButton } from '@expo/ui/jetpack-compose';
import {
  fillMaxWidth,
  weight,
  selectable,
  selectableGroup,
  padding,
  defaultMinSize,
  alpha,
} from '@expo/ui/jetpack-compose/modifiers';
import { StyleSheet } from 'react-native';
import { useTheme } from '../providers/theme-provider';
import { spacing } from '../theme/tokens';
import { makeRadioSelectHandler } from './RadioGroup.logic';
import type { RadioGroupProps } from './RadioGroup.types';

export function RadioGroup<T extends string>({ options, value, onChange }: RadioGroupProps<T>) {
  const { colorScheme } = useTheme();
  // Memoize so a stable `onChange` doesn't push a new handler into the native Host
  // (and re-render the Compose tree) on every parent render.
  const handleSelect = useMemo(() => makeRadioSelectHandler(onChange), [onChange]);

  return (
    // `matchContents={{ vertical: true }}` (NOT the boolean form, which sizes both
    // axes): the Host fills the parent's width so each Row's `fillMaxWidth()` has a
    // bounded width, while height tracks content. Mirrors SwitchRow.
    //
    // `colorScheme` pins the Compose MaterialTheme to our in-app Light/Dark
    // toggle, not the OS scheme — else the option labels go dark-on-dark when
    // the app runs dark on a light-mode phone (as SwitchRow/AppMenu do).
    <Host matchContents={{ vertical: true }} colorScheme={colorScheme} style={styles.host}>
      <Column modifiers={[fillMaxWidth(), selectableGroup()]}>
        {options.map((option) => {
          const selected = option.value === value;
          const disabled = !!option.disabled;
          const rowModifiers = [
            fillMaxWidth(),
            // ≥48dp tap target — the Material minimum touch target.
            defaultMinSize({ minHeight: 48 }),
            // The row owns the selection so the whole surface is tappable; omitted
            // when disabled so a tap is a no-op. `selectable` sits before `padding`
            // so the ripple covers the padded row, not just the content.
            ...(disabled ? [] : [selectable(selected, () => handleSelect(option), 'radioButton')]),
            padding(spacing[4], spacing[2], spacing[4], spacing[2]),
          ];
          return (
            <Row key={option.value} verticalAlignment="center" modifiers={rowModifiers}>
              {/* The Row's `selectable` owns the tap — leave the RadioButton passive
                  so a tap on it doesn't double-fire the selection. */}
              <RadioButton selected={selected} />
              <Column modifiers={disabled ? [weight(1), alpha(0.4)] : [weight(1)]}>
                <Text style={{ typography: 'bodyLarge' }}>{option.label}</Text>
                {option.description ? (
                  <Text style={{ typography: 'bodySmall' }} modifiers={[alpha(0.6)]}>
                    {option.description}
                  </Text>
                ) : null}
              </Column>
            </Row>
          );
        })}
      </Column>
    </Host>
  );
}

const styles = StyleSheet.create({
  host: {
    width: '100%',
  },
});
