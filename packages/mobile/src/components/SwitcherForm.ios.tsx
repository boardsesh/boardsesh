// SwitcherForm — iOS implementation, a real SwiftUI `Form` via @expo/ui/swift-ui.
//
// The whole OTA Channel / Branch switcher screen is ONE `Host` containing a single
// SwiftUI `Form` (the grouped, inset-rounded iOS Settings look — section insets,
// separators, and scrolling for free). Same consolidation as MoreForm /
// FeatureFlagsForm: the entire form lives under one `Host`, not one per control.
//
// HOST SIZING: a `Form` is a scrolling container that fills its space, so the Host
// uses `style={{ flex: 1 }}` + `useViewportSizeMeasurement` — NOT `matchContents`
// (which would size to content and clip the scroll). `colorScheme` forces the
// native appearance to follow the in-app Light/Dark toggle.
//
// The screen precomputes every string + handler + row state; this tree renders the
// model. Each row kind maps to the idiomatic SwiftUI control.

import { useCallback, useEffect, useMemo, useRef } from 'react';
import {
  Form,
  Section,
  Text,
  Button,
  Image,
  HStack,
  VStack,
  Spacer,
  ProgressView,
  TextField,
  useNativeState,
} from '@expo/ui/swift-ui';
import {
  tint,
  opacity,
  disabled as disabledModifier,
  accessibilityLabel as accessibilityLabelModifier,
  autocorrectionDisabled,
  textInputAutocapitalization,
  submitLabel as submitLabelModifier,
  onSubmit as onSubmitModifier,
  font,
  foregroundStyle,
} from '@expo/ui/swift-ui/modifiers';
import { StyleSheet } from 'react-native';
import { useTheme } from '../providers/theme-provider';
import { ThemedHost } from './ThemedHost';
import { brandAccentColor } from '../theme/expo-ui-modifiers';
import { spacing } from '../theme/tokens';
import { shouldPushValueToNative } from './AuthTextInput.logic';
import { assertNeverSwitcherRow } from './SwitcherForm.logic';
import type { SwitcherActionRow, SwitcherFieldRow, SwitcherFormProps, SwitcherTargetRow } from './SwitcherForm.types';

const PRIMARY_LABEL = foregroundStyle({ type: 'hierarchical', style: 'primary' });
const SECONDARY_LABEL = foregroundStyle({ type: 'hierarchical', style: 'secondary' });
const TERTIARY_LABEL = foregroundStyle({ type: 'hierarchical', style: 'tertiary' });
const FOOTNOTE = font({ textStyle: 'footnote' });

// Semantic action icon → SF Symbol. Cast at the call site (the SFSymbol union
// isn't resolvable from the shared types module), matching MoreForm.ios.
const ACTION_SF_SYMBOL = {
  switch: 'arrow.left.arrow.right',
  reset: 'arrow.counterclockwise',
  send: 'paperplane',
  warning: 'exclamationmark.triangle',
  flame: 'flame',
} as const;

// A single switch-target row's trailing accessory, by precomputed state. A
// `disabled` row (another switch in flight) keeps the chevron a pressable preview
// row would show — the whole row is just dimmed — matching the original.
function TargetTrailing({ row }: { row: SwitcherTargetRow }) {
  if (row.state === 'switching') return <ProgressView />;
  if (row.state === 'active') return <Image systemName="checkmark" modifiers={[SECONDARY_LABEL]} />;
  if ((row.state === 'pressable' || row.state === 'disabled') && row.showChevronWhenPressable) {
    return <Image systemName="chevron.right" modifiers={[FOOTNOTE, TERTIARY_LABEL]} />;
  }
  return null;
}

function TargetBody({ row }: { row: SwitcherTargetRow }) {
  return (
    // A `disabled` row dims to 0.5 (matching the Android `alpha(0.5)` and the
    // original RN opacity), so the row that's actually switching stands out.
    <HStack spacing={spacing[3]} modifiers={row.state === 'disabled' ? [opacity(0.5)] : undefined}>
      <VStack alignment="leading" spacing={spacing[1]}>
        <Text modifiers={[PRIMARY_LABEL]}>{row.title}</Text>
        {row.subtitle ? <Text modifiers={[FOOTNOTE, SECONDARY_LABEL]}>{row.subtitle}</Text> : null}
      </VStack>
      <Spacer />
      <TargetTrailing row={row} />
    </HStack>
  );
}

function TargetRow({ row }: { row: SwitcherTargetRow }) {
  // A pressable row is a Button; every other state renders as an inert HStack so an
  // active/switching/disabled row can't be tapped (the in-flight ref guarded this
  // before; the structure enforces it now). A `disabled` row is dimmed in TargetBody.
  if (row.state === 'pressable' && row.onPress) {
    return <Button onPress={row.onPress}>{<TargetBody row={row} />}</Button>;
  }
  return <TargetBody row={row} />;
}

// The manual channel / custom branch field. Bridges the controlled `value` into a
// native observable (reusing AuthTextInput's pure push-guard) and applies the same
// identifier-field modifiers: no autocaps, no autocorrect, a "go" submit key.
function FieldRow({ row }: { row: SwitcherFieldRow }) {
  const { brandColors } = useTheme();
  const textState = useNativeState(row.value);
  const lastEmittedRef = useRef(row.value);
  // `row.onSubmit` is rebuilt each render (the screen makes it inline), so keep the
  // latest in a ref and feed the modifier a STABLE closure — same stabilization as
  // the Android FieldRow (and AuthTextInput) so keystroke re-renders don't churn
  // the native handler registration.
  const submitRef = useRef(row.onSubmit);
  useEffect(() => {
    submitRef.current = row.onSubmit;
  }, [row.onSubmit]);

  useEffect(() => {
    if (shouldPushValueToNative(row.value, lastEmittedRef.current)) {
      lastEmittedRef.current = row.value;
      textState.set(row.value);
    }
  }, [row.value, textState]);

  // `row.onChangeText` is the screen's stable setState setter, so this is stable.
  const handleTextChange = useCallback(
    (text: string) => {
      lastEmittedRef.current = text;
      row.onChangeText(text);
    },
    [row.onChangeText],
  );

  const modifiers = useMemo(
    () => [
      tint(brandAccentColor(brandColors)),
      accessibilityLabelModifier(row.label),
      textInputAutocapitalization('never'),
      autocorrectionDisabled(true),
      submitLabelModifier('go'),
      onSubmitModifier(() => submitRef.current()),
      ...(row.editable ? [] : [disabledModifier(true)]),
    ],
    [brandColors, row.label, row.editable],
  );

  return (
    <TextField text={textState} placeholder={row.placeholder} onTextChange={handleTextChange} modifiers={modifiers} />
  );
}

type ActionIconColors = { accent: string; warning: string; error: string };

function ActionRow({ row, iconColors }: { row: SwitcherActionRow; iconColors: ActionIconColors }) {
  const modifiers = row.disabled ? [disabledModifier(true)] : [];
  // A bare destructive/standalone action is an idiomatic Form button (centred,
  // role-tinted); an action carrying a trailing icon (the Sentry rows) uses an
  // HStack so the glyph sits at the trailing edge like the RN ListRow did.
  if (!row.icon || row.icon === 'switch' || row.icon === 'reset') {
    return (
      <Button
        role={row.destructive ? 'destructive' : undefined}
        label={row.label}
        onPress={row.onPress}
        modifiers={modifiers}
      />
    );
  }
  // Semantic tint for the Sentry glyphs, matching the original RN icon colours:
  // warning amber, flame red, everything else the brand accent.
  const iconColor =
    row.icon === 'warning' ? iconColors.warning : row.icon === 'flame' ? iconColors.error : iconColors.accent;
  return (
    <Button role={row.destructive ? 'destructive' : undefined} onPress={row.onPress} modifiers={modifiers}>
      <HStack spacing={spacing[3]}>
        <Text modifiers={[PRIMARY_LABEL]}>{row.label}</Text>
        <Spacer />
        <Image systemName={ACTION_SF_SYMBOL[row.icon]} modifiers={[tint(iconColor)]} />
      </HStack>
    </Button>
  );
}

export function SwitcherForm({ model }: SwitcherFormProps) {
  const { brandColors } = useTheme();
  const accent = brandAccentColor(brandColors);
  const iconColors: ActionIconColors = { accent, warning: brandColors.warning, error: brandColors.error };

  return (
    <ThemedHost style={styles.host} useViewportSizeMeasurement>
      <Form>
        {model.sections.map((section) => (
          <Section
            key={section.key}
            title={section.title}
            footer={section.footer ? <Text>{section.footer}</Text> : undefined}
          >
            {section.intro ? <Text modifiers={[FOOTNOTE, SECONDARY_LABEL]}>{section.intro}</Text> : null}
            {section.rows.map((row) => {
              switch (row.kind) {
                case 'info':
                  return (
                    <HStack key={row.key} spacing={spacing[3]}>
                      <Text modifiers={[PRIMARY_LABEL]}>{row.label}</Text>
                      <Spacer />
                      <Text modifiers={[SECONDARY_LABEL]}>{row.value}</Text>
                    </HStack>
                  );
                case 'status':
                  return (
                    <HStack key={row.key} spacing={spacing[2]}>
                      {row.busy ? <ProgressView /> : null}
                      <Text modifiers={[FOOTNOTE, SECONDARY_LABEL]}>{row.label}</Text>
                    </HStack>
                  );
                case 'target':
                  return <TargetRow key={row.key} row={row} />;
                case 'field':
                  return <FieldRow key={row.key} row={row} />;
                case 'action':
                  return <ActionRow key={row.key} row={row} iconColors={iconColors} />;
                default:
                  return assertNeverSwitcherRow(row);
              }
            })}
          </Section>
        ))}
      </Form>
    </ThemedHost>
  );
}

const styles = StyleSheet.create({
  // A Form fills the screen; flex + useViewportSizeMeasurement give SwiftUI the
  // viewport as its proposed size so the Form scrolls within it.
  host: {
    flex: 1,
  },
});
