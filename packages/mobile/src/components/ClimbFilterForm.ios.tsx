// ClimbFilterForm — the body of the iOS Filters sheet (Liquid Glass), one SwiftUI
// `Form` in one `Host`: the grouped, inset-rounded look of iOS Settings (#6872).
//
// ClimbFilterSheet keeps the sheet itself (presentation, detents, the X / Filters /
// Reset bar, live apply, the picker-route round trip) and builds the rows
// (climb-filter-form-model.ts); this file only draws them. Most rows are settings
// rows drawn by settings-rows.ios, the renderer behind Settings. Two are its own:
// the climb-name field and the recent-searches menu.
//
// HOST SIZING: the Host fills the sheet column under the top bar (flex: 1). That
// column carries the detent height bound (useSheetColumnStyle, #3330), so the Host
// gets a real frame from Yoga and the Form scrolls inside it.
//
// KEYBOARD: the column is padded by the keyboard overlap (sheet-keyboard-inset.ts),
// so the Host ignores the keyboard safe area; otherwise the hosting controller
// insets the Form a second time.
//
// GLASS: `scrollContentBackground('hidden')` drops the Form's opaque grouped
// background so the sheet's own material shows between the cards. The cards keep
// their system fill: Liquid Glass is never drawn in the content layer.

import { useCallback, useLayoutEffect, useRef } from 'react';
import { Keyboard, PlatformColor, StyleSheet } from 'react-native';
import { Host } from '@expo/ui';
import { Button, Form, HStack, Image, Menu, Section, Spacer, Text, TextField, useNativeState } from '@expo/ui/swift-ui';
import {
  accessibilityLabel as accessibilityLabelModifier,
  autocorrectionDisabled,
  buttonStyle,
  listRowBackground,
  onSubmit as onSubmitModifier,
  scrollContentBackground,
  scrollDismissesKeyboard,
  submitLabel as submitLabelModifier,
  textInputAutocapitalization,
  tint,
} from '@expo/ui/swift-ui/modifiers';
import { useTheme } from '../providers/theme-provider';
import { brandAccentColor, brandControlTint } from '../theme/expo-ui-modifiers';
import { spacing } from '../theme/tokens';
import { shouldPushValueToNative } from './AuthTextInput.logic';
import { renderSettingsRow, type SettingsRowTints } from './settings-rows.ios';
import { CHEVRON, PRIMARY_LABEL, ROW_ICON, SECONDARY_LABEL, TERTIARY_LABEL } from './settings-row-styles.ios';
import type { ClimbFilterFormProps, ClimbFilterFormRow, FilterMenuRow, FilterNameRow } from './ClimbFilterForm.types';

const FORM_MODIFIERS = [scrollContentBackground('hidden'), scrollDismissesKeyboard('interactively')];
// An opaque card fill. Over the sheet's glass a Form row's own fill is
// translucent, and in light mode the list behind (its red grades) showed through
// the rows. The system grouped-card colour follows light/dark and Increase
// Contrast, like the cards in Settings.
const SECTION_MODIFIERS = [listRowBackground(PlatformColor('secondarySystemGroupedBackground'))];

/**
 * The climb-name search. The value is controlled by the sheet (it owns the draft
 * and the debounce), bridged into a native observable with the same push guard
 * as AuthTextInput so our own keystrokes don't echo back and jump the caret.
 * Never auto-focused: opening Filters must not raise the keyboard.
 */
function NameRow({ row, controlTint }: { row: FilterNameRow; controlTint: string }) {
  const textState = useNativeState(row.value);
  const lastEmittedRef = useRef(row.value);
  const onChangeTextRef = useRef(row.onChangeText);
  onChangeTextRef.current = row.onChangeText;
  const onFocusRef = useRef(row.onFocus);
  onFocusRef.current = row.onFocus;

  // A layout effect, so the guard runs in the commit, before the next keystroke's
  // handler: a passive effect could run after it and push the older value back.
  useLayoutEffect(() => {
    if (shouldPushValueToNative(row.value, lastEmittedRef.current)) {
      lastEmittedRef.current = row.value;
      textState.set(row.value);
    }
  }, [row.value, textState]);

  const handleTextChange = useCallback((text: string) => {
    lastEmittedRef.current = text;
    onChangeTextRef.current(text);
  }, []);
  const handleFocusChange = useCallback((focused: boolean) => {
    if (focused) onFocusRef.current();
  }, []);

  return (
    <HStack spacing={spacing[2]}>
      <Image systemName="magnifyingglass" modifiers={[ROW_ICON, SECONDARY_LABEL]} />
      <TextField
        text={textState}
        placeholder={row.placeholder}
        onTextChange={handleTextChange}
        onFocusChange={handleFocusChange}
        modifiers={[
          tint(controlTint),
          accessibilityLabelModifier(row.accessibilityLabel),
          // Climb names are made-up words; autocorrect would rewrite them.
          textInputAutocapitalization('never'),
          autocorrectionDisabled(true),
          // Results are already live, so Search only puts the keyboard away.
          submitLabelModifier('search'),
          onSubmitModifier(() => Keyboard.dismiss()),
        ]}
      />
      {row.value.length > 0 ? (
        // Borderless, so a tap elsewhere in the row doesn't fire it (a Form row
        // runs every plain Button in it on a row tap).
        <Button
          onPress={row.onClear}
          modifiers={[buttonStyle('borderless'), accessibilityLabelModifier(row.clearLabel)]}
        >
          <Image systemName="xmark.circle.fill" modifiers={[ROW_ICON, TERTIARY_LABEL]} />
        </Button>
      ) : null}
    </HStack>
  );
}

/** A settings row that opens a menu of actions; the one in force is ticked. */
function MenuRow({ row }: { row: FilterMenuRow }) {
  return (
    <Menu
      label={
        <HStack spacing={spacing[2]}>
          <Text modifiers={[PRIMARY_LABEL]}>{row.label}</Text>
          <Spacer />
          {row.value ? <Text modifiers={[SECONDARY_LABEL]}>{row.value}</Text> : null}
          <Image systemName="chevron.up.chevron.down" modifiers={[CHEVRON, TERTIARY_LABEL]} />
        </HStack>
      }
    >
      {row.items.map((item) => (
        <Button
          key={item.key}
          label={item.label}
          systemImage={item.checked ? 'checkmark' : undefined}
          onPress={() => row.onSelect(item.key)}
        />
      ))}
    </Menu>
  );
}

function renderFilterRow(row: ClimbFilterFormRow, tints: SettingsRowTints) {
  switch (row.kind) {
    case 'name':
      return <NameRow key={row.key} row={row} controlTint={tints.control} />;
    case 'menu':
      return <MenuRow key={row.key} row={row} />;
    default:
      return renderSettingsRow(row, tints);
  }
}

export function ClimbFilterForm({ model }: ClimbFilterFormProps) {
  const { brandColors, colorScheme } = useTheme();
  const tints: SettingsRowTints = { control: brandControlTint(brandColors), fill: brandAccentColor(brandColors) };

  return (
    <Host style={styles.host} colorScheme={colorScheme} ignoreSafeArea="keyboard">
      <Form modifiers={FORM_MODIFIERS}>
        {model.sections.map((section) => (
          <Section
            key={section.key}
            title={section.title}
            footer={section.footer ? <Text>{section.footer}</Text> : undefined}
            modifiers={SECTION_MODIFIERS}
          >
            {section.rows.map((row) => renderFilterRow(row, tints))}
          </Section>
        ))}
      </Form>
    </Host>
  );
}

const styles = StyleSheet.create({
  host: {
    flex: 1,
  },
});
