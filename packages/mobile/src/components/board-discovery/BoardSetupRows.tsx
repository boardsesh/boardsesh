// Set up's Board, Layout and Size as inset-grouped rows (flag `add-board-wizard`),
// in place of three walls of wrapping chips. Each row is its label and the
// current value; a tap opens a native menu (`AppMenu`) for up to eight options,
// or the pushed checklist for more (`setupRowControl`), so a long list of sizes
// is a list you scroll, not a menu running off the screen.

import { memo, useCallback, useMemo, useState } from 'react';
import { StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import { AppMenu, type AppMenuAction } from '../AppMenu';
import { Icon } from '../Icon';
import { InsetGroupedList, insetGroupedRowStyles } from '../InsetGroupedList';
import { PressableSurface } from '../PressableSurface';
import { Text } from '../Text';
import { useTheme } from '../../providers/theme-provider';
import { opacity } from '../../theme/tokens';
import { ROW_GUTTER } from '../art-slot';
import { setupRowControl, type SetupOptionField } from '../../lib/boards/setup-option-handoff';
/** One option of a row, in the order the menu or checklist lists them. */
export type SetupRowOption = { key: string | number; label: string; selected: boolean };

export type SetupRowModel = {
  /** The row's label ("Layout"). */
  label: string;
  options: readonly SetupRowOption[];
  /** The option at `index` of `options` was picked from the menu. */
  onSelectIndex: (index: number) => void;
  /** The field the pushed checklist edits, for a row that may have more than eight options. */
  listField?: SetupOptionField;
  testID: string;
};

export type BoardSetupRowsProps = {
  /** Drawn in order; a row with no options is left out. */
  rows: readonly SetupRowModel[];
  /** "Choose", for a row with nothing picked yet. */
  placeholder: string;
  /** Read-only: an edit of a board whose setup is locked. */
  disabled?: boolean;
  /** Push the checklist for a row with more than eight options. */
  onOpenList: (field: SetupOptionField) => void;
};

export function BoardSetupRows({ rows, placeholder, disabled = false, onOpenList }: BoardSetupRowsProps) {
  const shown = rows.filter((row) => row.options.length > 0);
  if (shown.length === 0) return null;
  return (
    <View
      pointerEvents={disabled ? 'none' : 'auto'}
      accessibilityState={{ disabled }}
      style={disabled ? styles.locked : undefined}
    >
      <InsetGroupedList separatorInset="gutter" testID="board-setup-rows">
        {shown.map((row) => (
          <SetupChoiceRow key={row.testID} row={row} placeholder={placeholder} onOpenList={onOpenList} />
        ))}
      </InsetGroupedList>
    </View>
  );
}

/** One row: its label, then the value as a menu anchor or a row that pushes the checklist. */
const SetupChoiceRow = memo(function SetupChoiceRow({
  row,
  placeholder,
  onOpenList,
}: {
  row: SetupRowModel;
  placeholder: string;
  onOpenList: (field: SetupOptionField) => void;
}) {
  const { systemColors } = useTheme();
  const { label, options, onSelectIndex, listField, testID } = row;
  const value = options.find((option) => option.selected)?.label ?? placeholder;
  const control = listField ? setupRowControl(options.length) : 'menu';
  const actions = useMemo<AppMenuAction[]>(
    () => options.map((option) => ({ label: option.label, selected: option.selected })),
    [options],
  );
  const openList = useCallback(() => {
    if (listField) onOpenList(listField);
  }, [listField, onOpenList]);
  // The menu's anchor is native and sizes to its label: cap it at the row's
  // inner width, so a long size ("10×12 · Full Ride") truncates at 320 pt
  // instead of running off the card.
  const [anchorMaxWidth, setAnchorMaxWidth] = useState<number | undefined>(undefined);
  const onRowLayout = useCallback((event: LayoutChangeEvent) => {
    const inner = Math.floor(event.nativeEvent.layout.width - ROW_GUTTER * 2);
    setAnchorMaxWidth((previous) => (previous === inner || inner <= 0 ? previous : inner));
  }, []);

  if (control === 'list') {
    return (
      <PressableSurface
        onPress={openList}
        feedback="opacity"
        rippleColor={systemColors.label as string}
        accessibilityRole="button"
        accessibilityLabel={`${label}, ${value}`}
        style={[insetGroupedRowStyles.row, styles.row]}
        testID={testID}
      >
        <Text variant="body" style={styles.label}>
          {label}
        </Text>
        {/* The same value style as a menu row's anchor: the label colour,
            regular weight, one line, a small secondary glyph after it. */}
        <View style={styles.listValue}>
          <Text variant="body" color={systemColors.label} numberOfLines={1} style={styles.valueText}>
            {value}
          </Text>
          <Icon name="chevron.right" size={VALUE_GLYPH_SIZE} color={systemColors.secondaryLabel} />
        </View>
      </PressableSurface>
    );
  }

  return (
    <View style={[insetGroupedRowStyles.row, styles.row]} onLayout={onRowLayout} testID={testID}>
      <Text
        variant="body"
        style={styles.label}
        // The menu's own name starts with it: a screen reader reads the row once, on the control.
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      >
        {label}
      </Text>
      <AppMenu
        label={value}
        accessibilityLabel={`${label}, ${value}`}
        actions={actions}
        onSelectIndex={onSelectIndex}
        maxWidth={anchorMaxWidth}
      />
    </View>
  );
});

/** The pushed row's trailing glyph: the size of a menu anchor's caret. */
const VALUE_GLYPH_SIZE = 13;

const styles = StyleSheet.create({
  row: {
    flexWrap: 'wrap',
    justifyContent: 'space-between',
  },
  label: {
    flexShrink: 1,
  },
  listValue: {
    flexDirection: 'row',
    alignItems: 'center',
    flexShrink: 1,
    gap: 6,
  },
  valueText: {
    flexShrink: 1,
    textAlign: 'right',
  },
  locked: { opacity: opacity.disabled },
});
