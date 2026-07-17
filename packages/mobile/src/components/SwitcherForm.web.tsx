// SwitcherForm — web implementation (react-native-web + react-native-paper). The
// OTA Channel / Branch switcher screens, rendered from the same plain
// `SwitcherFormModel` the native files consume. Structurally follows
// SwitcherForm.android.tsx: each section flattens to an optional title, an optional
// intro, a Material card (`Surface`) wrapping all its rows (info / status / target /
// field / action), then an optional footer.
//
// This is a Phase-0 minimal-functional port: every row kind renders and its
// handlers fire. Action rows are label-only (matching Android, which skips the
// per-glyph drawable plumbing). The switch-target state machine + the row-kind
// exhaustiveness guard live in SwitcherForm.logic.ts, shared with both native files.

import { type ReactNode } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { ActivityIndicator, Surface, TextInput } from 'react-native-paper';
import { useTheme } from '../providers/theme-provider';
import { spacing } from '../theme/tokens';
import { assertNeverSwitcherRow, isSwitchRowPressable } from './SwitcherForm.logic';
import type {
  SwitcherActionRow,
  SwitcherFieldRow,
  SwitcherFormProps,
  SwitcherRow,
  SwitcherSection,
  SwitcherTargetRow,
} from './SwitcherForm.types';

const CHEVRON = '›';
const CHECK = '✓';

type RowColors = {
  label: string;
  secondaryLabel: string;
  error: string;
};

function TargetTrailing({ row, colors }: { row: SwitcherTargetRow; colors: RowColors }) {
  if (row.state === 'switching') return <ActivityIndicator size={18} />;
  if (row.state === 'active') return <Text style={[styles.glyph, { color: colors.secondaryLabel }]}>{CHECK}</Text>;
  if ((row.state === 'pressable' || row.state === 'disabled') && row.showChevronWhenPressable) {
    return <Text style={[styles.glyph, { color: colors.secondaryLabel }]}>{CHEVRON}</Text>;
  }
  return null;
}

function TargetRow({ row, colors }: { row: SwitcherTargetRow; colors: RowColors }) {
  const pressable = isSwitchRowPressable(row.state) && row.onPress != null;
  const content = (
    <View style={[styles.row, row.state === 'disabled' ? styles.dimmed : null]}>
      <View style={styles.rowText}>
        <Text style={[styles.rowTitle, { color: colors.label }]}>{row.title}</Text>
        {row.subtitle ? (
          <Text style={[styles.rowSubtitle, { color: colors.secondaryLabel }]}>{row.subtitle}</Text>
        ) : null}
      </View>
      <TargetTrailing row={row} colors={colors} />
    </View>
  );
  return pressable ? <Pressable onPress={row.onPress}>{content}</Pressable> : content;
}

function FieldRow({ row }: { row: SwitcherFieldRow }) {
  return (
    <View style={styles.fieldRow}>
      <TextInput
        mode="outlined"
        label={row.label}
        placeholder={row.placeholder}
        value={row.value}
        onChangeText={row.onChangeText}
        onSubmitEditing={row.onSubmit}
        editable={row.editable}
        autoCapitalize="none"
        autoCorrect={false}
        returnKeyType="go"
        accessibilityLabel={row.label}
      />
    </View>
  );
}

function ActionRow({ row, colors }: { row: SwitcherActionRow; colors: RowColors }) {
  const content = (
    <View style={[styles.row, row.disabled ? styles.dimmed : null]}>
      <Text style={[styles.rowTitle, { color: row.destructive ? colors.error : colors.label }]}>{row.label}</Text>
    </View>
  );
  return row.disabled ? content : <Pressable onPress={row.onPress}>{content}</Pressable>;
}

function renderRow(row: SwitcherRow, colors: RowColors): ReactNode {
  switch (row.kind) {
    case 'info':
      return (
        <View key={row.key} style={styles.row}>
          <Text style={[styles.rowTitle, styles.flex, { color: colors.label }]}>{row.label}</Text>
          <Text style={[styles.rowValue, { color: colors.secondaryLabel }]}>{row.value}</Text>
        </View>
      );
    case 'status':
      return (
        <View key={row.key} style={styles.row}>
          {row.busy ? <ActivityIndicator size={18} style={styles.statusSpinner} /> : null}
          <Text style={[styles.rowSubtitle, { color: colors.secondaryLabel }]}>{row.label}</Text>
        </View>
      );
    case 'target':
      return <TargetRow key={row.key} row={row} colors={colors} />;
    case 'field':
      return <FieldRow key={row.key} row={row} />;
    case 'action':
      return <ActionRow key={row.key} row={row} colors={colors} />;
    default:
      return assertNeverSwitcherRow(row);
  }
}

function Section({ section, colors }: { section: SwitcherSection; colors: RowColors }) {
  return (
    <View style={styles.section}>
      {section.title ? (
        <Text style={[styles.sectionTitle, { color: colors.secondaryLabel }]}>{section.title}</Text>
      ) : null}
      {section.intro ? (
        <Text style={[styles.sectionNote, { color: colors.secondaryLabel }]}>{section.intro}</Text>
      ) : null}
      <Surface style={styles.card} elevation={1}>
        {section.rows.map((row) => renderRow(row, colors))}
      </Surface>
      {section.footer ? (
        <Text style={[styles.sectionNote, { color: colors.secondaryLabel }]}>{section.footer}</Text>
      ) : null}
    </View>
  );
}

export function SwitcherForm({ model }: SwitcherFormProps) {
  const { systemColors, brandColors } = useTheme();
  const colors: RowColors = {
    label: systemColors.label as string,
    secondaryLabel: systemColors.secondaryLabel as string,
    error: brandColors.error,
  };

  return (
    <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>
      {model.sections.map((section) => (
        <Section key={section.key} section={section} colors={colors} />
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: {
    flex: 1,
  },
  content: {
    padding: spacing[4],
    paddingBottom: spacing[10],
    gap: spacing[3],
  },
  section: {
    gap: spacing[2],
  },
  sectionTitle: {
    fontSize: 13,
    fontWeight: '600',
    opacity: 0.7,
  },
  sectionNote: {
    fontSize: 12,
    opacity: 0.6,
  },
  card: {
    borderRadius: 12,
    overflow: 'hidden',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing[4],
    paddingVertical: spacing[3],
    gap: spacing[2],
    minHeight: 48,
  },
  rowText: {
    flex: 1,
    gap: spacing[1],
  },
  flex: {
    flex: 1,
  },
  rowTitle: {
    fontSize: 16,
  },
  rowSubtitle: {
    fontSize: 13,
    opacity: 0.8,
  },
  rowValue: {
    fontSize: 15,
  },
  dimmed: {
    opacity: 0.5,
  },
  glyph: {
    fontSize: 18,
  },
  statusSpinner: {
    marginRight: spacing[2],
  },
  fieldRow: {
    paddingHorizontal: spacing[4],
    paddingVertical: spacing[3],
  },
});
