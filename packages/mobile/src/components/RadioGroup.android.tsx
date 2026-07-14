// RadioGroup — Android implementation, real Jetpack Compose via
// @expo/ui/jetpack-compose.
//
// `variant='inline'` (default): a Compose `Column` (marked a `selectableGroup` for
// TalkBack) of `Row`s, each a leading `RadioButton` + a label/description `Column`.
// The whole row owns the selection via the `selectable` modifier (role
// 'radioButton'), so a tap anywhere picks it and TalkBack reads the row as a radio
// option labelled by its text. The RadioButton's own `onClick` is left undefined so
// the tap fires once, not twice. Unlike iOS, Android CAN show the per-option
// `description` and disable a row, so the public API's full fidelity survives here.
// Brand tint comes from the Compose Material theme the Host sets up (RadioButton has
// no colours prop — it reads M3 `primary`, which is the brand accent under our
// theme).
//
// `variant='menu'`: a Material 3 `ExposedDropdownMenuBox` — a single anchor row
// showing the selected label + a trailing drop-down arrow that opens the options in
// a native menu on tap, so the control only expands when pressed. Like the iOS menu
// Picker, it drops per-option `description`/`disabled` (neither menu call site uses
// them).
//
// One Host per control is intentional for now (RadioGroup is used one-per-card).

import { useMemo, useState } from 'react';
import { Host } from '@expo/ui';
import {
  Column,
  Row,
  Text,
  RadioButton,
  Icon,
  ExposedDropdownMenuBox,
  ExposedDropdownMenu,
  DropdownMenuItem,
} from '@expo/ui/jetpack-compose';
import {
  fillMaxWidth,
  weight,
  selectable,
  selectableGroup,
  menuAnchor,
  padding,
  defaultMinSize,
  alpha,
} from '@expo/ui/jetpack-compose/modifiers';
import { StyleSheet } from 'react-native';
import { spacing } from '../theme/tokens';
import { useTheme } from '../providers/theme-provider';
import { makeRadioSelectHandler } from './RadioGroup.logic';
import type { RadioGroupProps } from './RadioGroup.types';

const ARROW_DROP_DOWN_ICON = require('../../assets/material-icons/arrow-drop-down.xml');

export function RadioGroup<T extends string>({ options, value, onChange, variant = 'inline' }: RadioGroupProps<T>) {
  // Memoize so a stable `onChange` doesn't push a new handler into the native Host
  // (and re-render the Compose tree) on every parent render.
  const handleSelect = useMemo(() => makeRadioSelectHandler(onChange), [onChange]);

  if (variant === 'menu') {
    return <MenuRadioGroup options={options} value={value} onSelect={handleSelect} />;
  }

  return (
    // `matchContents={{ vertical: true }}` (NOT the boolean form, which sizes both
    // axes): the Host fills the parent's width so each Row's `fillMaxWidth()` has a
    // bounded width, while height tracks content. Mirrors SwitchRow.
    <Host matchContents={{ vertical: true }} style={styles.host}>
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

// Material 3 exposed dropdown: a read-only anchor row (selected label + trailing
// arrow) that toggles a native menu. `menuAnchor()` wires the tap + a11y; the
// ExposedDropdownMenuBox owns the expanded state so tapping the field, an item, or
// outside all resolve through `onExpandedChange`/`onDismissRequest`.
function MenuRadioGroup<T extends string>({
  options,
  value,
  onSelect,
}: {
  options: RadioGroupProps<T>['options'];
  value: T;
  onSelect: (option: RadioGroupProps<T>['options'][number]) => void;
}) {
  const { systemColors } = useTheme();
  const [expanded, setExpanded] = useState(false);
  const selectedLabel = options.find((option) => option.value === value)?.label ?? '';

  return (
    <Host matchContents={{ vertical: true }} style={styles.host}>
      <ExposedDropdownMenuBox expanded={expanded} onExpandedChange={setExpanded}>
        <Row
          verticalAlignment="center"
          modifiers={[
            menuAnchor(),
            fillMaxWidth(),
            defaultMinSize({ minHeight: 48 }),
            padding(spacing[4], spacing[2], spacing[4], spacing[2]),
          ]}
        >
          <Text modifiers={[weight(1)]} style={{ typography: 'bodyLarge' }}>
            {selectedLabel}
          </Text>
          {/* Tint from the theme, not the XML's baked-in white — otherwise the
              arrow is invisible against a light row background in light mode. */}
          <Icon source={ARROW_DROP_DOWN_ICON} tint={systemColors.secondaryLabel} />
        </Row>
        <ExposedDropdownMenu expanded={expanded} onDismissRequest={() => setExpanded(false)}>
          {options.map((option) => (
            <DropdownMenuItem
              key={option.value}
              onClick={() => {
                onSelect(option);
                setExpanded(false);
              }}
            >
              <DropdownMenuItem.Text>
                <Text>{option.label}</Text>
              </DropdownMenuItem.Text>
            </DropdownMenuItem>
          ))}
        </ExposedDropdownMenu>
      </ExposedDropdownMenuBox>
    </Host>
  );
}

const styles = StyleSheet.create({
  host: {
    width: '100%',
  },
});
