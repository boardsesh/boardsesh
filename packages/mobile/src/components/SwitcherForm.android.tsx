// SwitcherForm — Android implementation, a Jetpack Compose `LazyColumn` of
// Material cards via @expo/ui/jetpack-compose.
//
// The whole OTA Channel / Branch switcher screen is ONE `Host` containing a single
// `LazyColumn` — the Compose counterpart to the iOS `Form`. Same consolidation as
// MoreForm / FeatureFlagsForm. A `LazyColumn` virtualizes its items, so the Host is
// `style={{ flex: 1 }}` (NOT `matchContents`). `ThemedHost` forces the Compose
// MaterialTheme onto the in-app Light/Dark toggle.
//
// Each section flattens to: an optional title `Text`, an optional intro `Text`, a
// Material `Card` wrapping ALL its rows (info / status / target / field / action),
// then an optional footer `Text`. Action rows render as clickable rows inside the
// card (matching the RN `ListRow` look the screen had), not standalone filled
// buttons — on iOS the parallel Form `Button` is already a row. Brand colours come
// from the `expo-ui-modifiers` bridge; M3 surface/label colours come from the
// Compose Material theme.

import { useCallback, useEffect, useMemo, useRef, type ReactNode } from 'react';
import {
  LazyColumn,
  Card,
  Column,
  Row,
  Text,
  Spacer,
  OutlinedTextField,
  CircularProgressIndicator,
  useNativeState,
} from '@expo/ui/jetpack-compose';
import { fillMaxWidth, padding, alpha, weight, clickable, size } from '@expo/ui/jetpack-compose/modifiers';
import { StyleSheet } from 'react-native';
import { useTheme } from '../providers/theme-provider';
import { ThemedHost } from './ThemedHost';
import { textFieldBrandColors } from '../theme/expo-ui-modifiers';
import { spacing } from '../theme/tokens';
import { shouldPushValueToNative, toAndroidKeyboardOptions } from './AuthTextInput.logic';
import { assertNeverSwitcherRow } from './SwitcherForm.logic';
import type {
  SwitcherActionRow,
  SwitcherFieldRow,
  SwitcherFormProps,
  SwitcherRow,
  SwitcherSection,
  SwitcherTargetRow,
} from './SwitcherForm.types';

const ROW_PADDING = padding(spacing[4], spacing[3], spacing[4], spacing[3]);
const CHEVRON = '›';
const CHECK = '✓';

// The manual channel / custom branch field is always a plain identifier input, so
// its Compose keyboard options are fully static — hoisted so the native field
// isn't handed a fresh object on every keystroke-driven re-render.
const FIELD_KEYBOARD_OPTIONS = toAndroidKeyboardOptions({
  keyboardType: undefined,
  autoCapitalize: 'none',
  autoCorrect: false,
  returnKeyType: 'go',
  secureTextEntry: false,
});

function TargetTrailing({ row }: { row: SwitcherTargetRow }) {
  if (row.state === 'switching') return <CircularProgressIndicator modifiers={[size(20, 20)]} strokeWidth={2} />;
  if (row.state === 'active') {
    return (
      <Text style={{ typography: 'titleMedium' }} modifiers={[alpha(0.7)]}>
        {CHECK}
      </Text>
    );
  }
  // A `disabled` row (another switch in flight) keeps the chevron — the whole Row
  // is dimmed via alpha(0.5) — matching the original and the iOS side.
  if ((row.state === 'pressable' || row.state === 'disabled') && row.showChevronWhenPressable) {
    return (
      <Text style={{ typography: 'titleMedium' }} modifiers={[alpha(0.4)]}>
        {CHEVRON}
      </Text>
    );
  }
  return null;
}

function TargetRow({ row }: { row: SwitcherTargetRow }) {
  // `disabled` (another row switching) dims to 0.5, matching the RN opacity; every
  // other non-pressable state renders at full opacity, tap unwired.
  const rowModifiers = [
    fillMaxWidth(),
    ...(row.state === 'pressable' && row.onPress ? [clickable(row.onPress)] : []),
    ROW_PADDING,
    ...(row.state === 'disabled' ? [alpha(0.5)] : []),
  ];
  return (
    <Row modifiers={rowModifiers} verticalAlignment="center">
      <Column modifiers={[weight(1)]} verticalArrangement={{ spacedBy: spacing[1] }}>
        <Text style={{ typography: 'bodyLarge' }}>{row.title}</Text>
        {row.subtitle ? (
          <Text style={{ typography: 'bodySmall' }} modifiers={[alpha(0.6)]}>
            {row.subtitle}
          </Text>
        ) : null}
      </Column>
      <Spacer modifiers={[padding(spacing[2], 0, 0, 0)]} />
      <TargetTrailing row={row} />
    </Row>
  );
}

function FieldRow({ row }: { row: SwitcherFieldRow }) {
  const { brandColors, chartColors } = useTheme();
  const textState = useNativeState(row.value);
  const lastEmittedRef = useRef(row.value);
  // `row.onSubmit` is rebuilt each render (the screen makes it inline), so keep the
  // latest in a ref and hand the native field a STABLE keyboardActions object —
  // mirroring AuthTextInput.android's memoized keyboardActions.
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
  const handleValueChange = useCallback(
    (text: string) => {
      lastEmittedRef.current = text;
      row.onChangeText(text);
    },
    [row.onChangeText],
  );
  const keyboardActions = useMemo(() => ({ onGo: () => submitRef.current() }), []);
  const colors = useMemo(() => textFieldBrandColors(brandColors, chartColors), [brandColors, chartColors]);

  return (
    <Column modifiers={[fillMaxWidth(), ROW_PADDING]}>
      <OutlinedTextField
        value={textState}
        onValueChange={handleValueChange}
        readOnly={!row.editable}
        singleLine
        keyboardOptions={FIELD_KEYBOARD_OPTIONS}
        keyboardActions={keyboardActions}
        colors={colors}
        modifiers={[fillMaxWidth()]}
      >
        <OutlinedTextField.Label>
          <Text>{row.label}</Text>
        </OutlinedTextField.Label>
        <OutlinedTextField.Placeholder>
          <Text>{row.placeholder}</Text>
        </OutlinedTextField.Placeholder>
      </OutlinedTextField>
    </Column>
  );
}

// Label-only by design: unlike iOS (SF Symbols are free), an Android trailing icon
// needs a bundled XML vector drawable per glyph. The action rows are the tester-only
// Sentry rows + the Switch/Reset actions whose labels already carry the meaning, so
// we skip the per-glyph drawable plumbing rather than ship a partial icon set.
function ActionRow({ row, errorColor }: { row: SwitcherActionRow; errorColor: string }) {
  const rowModifiers = [
    fillMaxWidth(),
    ...(row.disabled ? [] : [clickable(row.onPress)]),
    ROW_PADDING,
    ...(row.disabled ? [alpha(0.5)] : []),
  ];
  return (
    <Row modifiers={rowModifiers} verticalAlignment="center">
      <Text style={{ typography: 'bodyLarge' }} color={row.destructive ? errorColor : undefined}>
        {row.label}
      </Text>
    </Row>
  );
}

function renderRow(row: SwitcherRow, errorColor: string): ReactNode {
  switch (row.kind) {
    case 'info':
      return (
        <Row key={row.key} modifiers={[fillMaxWidth(), ROW_PADDING]} verticalAlignment="center">
          <Column modifiers={[weight(1)]}>
            <Text style={{ typography: 'bodyLarge' }}>{row.label}</Text>
          </Column>
          <Text style={{ typography: 'bodyMedium' }} modifiers={[alpha(0.6)]}>
            {row.value}
          </Text>
        </Row>
      );
    case 'status':
      return (
        <Row key={row.key} modifiers={[fillMaxWidth(), ROW_PADDING]} verticalAlignment="center">
          {row.busy ? (
            <CircularProgressIndicator modifiers={[size(20, 20), padding(0, 0, spacing[3], 0)]} strokeWidth={2} />
          ) : null}
          <Text style={{ typography: 'bodySmall' }} modifiers={[alpha(0.6)]}>
            {row.label}
          </Text>
        </Row>
      );
    case 'target':
      return <TargetRow key={row.key} row={row} />;
    case 'field':
      return <FieldRow key={row.key} row={row} />;
    case 'action':
      return <ActionRow key={row.key} row={row} errorColor={errorColor} />;
    default:
      return assertNeverSwitcherRow(row);
  }
}

type SectionColors = {
  error: string;
  /** Ink for the section title / intro / footer, which sit outside the Card. */
  muted: string;
};

// The title, intro and footer are siblings of the Card, not children of it, so
// nothing supplies Compose's ambient `LocalContentColor` — its default is black in
// BOTH schemes. They take an explicit colour; the carded rows inherit the Card's
// content colour and correctly do not.
function flattenSection(section: SwitcherSection, colors: SectionColors): ReactNode[] {
  const items: ReactNode[] = [];
  if (section.title) {
    items.push(
      <Text key={`${section.key}-title`} style={{ typography: 'titleSmall' }} color={colors.muted}>
        {section.title}
      </Text>,
    );
  }
  if (section.intro) {
    items.push(
      <Text key={`${section.key}-intro`} style={{ typography: 'bodySmall' }} color={colors.muted}>
        {section.intro}
      </Text>,
    );
  }
  items.push(
    <Card key={`${section.key}-card`} modifiers={[fillMaxWidth()]}>
      <Column modifiers={[fillMaxWidth()]}>{section.rows.map((row) => renderRow(row, colors.error))}</Column>
    </Card>,
  );
  if (section.footer) {
    items.push(
      <Text key={`${section.key}-footer`} style={{ typography: 'bodySmall' }} color={colors.muted}>
        {section.footer}
      </Text>,
    );
  }
  return items;
}

export function SwitcherForm({ model }: SwitcherFormProps) {
  // `chartColors` mirrors `systemColors` as guaranteed plain strings, which is
  // what native Compose colour props need.
  const { brandColors, chartColors } = useTheme();
  const items = model.sections.flatMap((section) =>
    flattenSection(section, { error: brandColors.error, muted: chartColors.secondaryLabel }),
  );

  return (
    <ThemedHost style={styles.host}>
      <LazyColumn
        contentPadding={{ start: spacing[4], top: spacing[4], end: spacing[4], bottom: spacing[10] }}
        verticalArrangement={{ spacedBy: spacing[3] }}
      >
        {items}
      </LazyColumn>
    </ThemedHost>
  );
}

const styles = StyleSheet.create({
  // A LazyColumn virtualizes its rows and needs a bounded height to fill.
  host: {
    flex: 1,
  },
});
