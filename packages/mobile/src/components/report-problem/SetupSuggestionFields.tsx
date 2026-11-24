// The setup fields on a "Set up wrong" report (docs/product/directory-reports.md,
// "Suggested setup"): Layout, Size, Holds and, on a board that doesn't tilt,
// Angle. Each row is a label, its value and a native menu, like the board
// sheet's keep-lighting row. They open on the board's current setup; the climber
// changes what's different on the wall.
//
// The state is the caller's (`setupSelectionReducer` from @boardsesh/board-config),
// so the reset rules are the board builder's: a new layout takes its default
// size and every set of it, a new size every set of it. The words are
// board-config's setup labels, the same ones www's fields and every summary use.

import { memo, useCallback, useMemo, useRef } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import {
  setupAngleLabel,
  setupLayoutLabel,
  setupSelectionOptions,
  setupSizeLabel,
  type SetupSelection,
  type SetupSelectionAction,
  type SetupSelectionOptions,
} from '@boardsesh/board-config';
import { AppMenu } from '../AppMenu';
import type { AppMenuAction } from '../AppMenu';
import { InsetGroupedList, insetGroupedRowStyles } from '../InsetGroupedList';
import { Text } from '../Text';
import { useFeatureFlag } from '../../providers/feature-flags-provider';

const NO_SETS: number[] = [];

export type SetupSuggestionFieldsProps = {
  selection: SetupSelection;
  /** The reducer's dispatch. */
  onAction: (action: SetupSelectionAction) => void;
  /** Locks the rows while the report is in flight. */
  disabled?: boolean;
};

export function SetupSuggestionFields({ selection, onAction, disabled = false }: SetupSuggestionFieldsProps) {
  const { t } = useTranslation('boards');
  // A row whose value the catalogue doesn't list (a layout this build lacks, a
  // size or sets it doesn't list) reads "Choose" rather than blank.
  const choose = t('mobile.setupSuggestion.choose');
  const wideAnglesEnabled = useFeatureFlag('moonboard-wide-angles') === true;
  const { boardName, layoutId, sizeId, setIds, angle, angleIsFixed } = selection;

  // What each row offers depends only on the levels above it, so a set toggle
  // or an angle pick reads the same lists back.
  const options = useMemo(
    () =>
      setupSelectionOptions(
        { boardName, layoutId, sizeId, setIds: NO_SETS, angle: 0, angleIsFixed },
        {
          wideAnglesEnabled,
        },
      ),
    [boardName, layoutId, sizeId, angleIsFixed, wideAnglesEnabled],
  );
  const selectedSetIds = useMemo(() => new Set(setIds), [setIds]);

  // A native menu can deliver a tap queued before this render: the handlers
  // read the lists and selection as they are now, and stay stable for the rows.
  const latest = useRef<{ options: SetupSelectionOptions; selectedSetIds: Set<number>; onAction: typeof onAction }>({
    options,
    selectedSetIds,
    onAction,
  });
  latest.current = { options, selectedSetIds, onAction };

  const pickLayout = useCallback((index: number) => {
    const layout = latest.current.options.layouts[index];
    if (layout) latest.current.onAction({ type: 'selectLayout', layoutId: layout.id });
  }, []);
  const pickSize = useCallback((index: number) => {
    const size = latest.current.options.sizes[index];
    if (size) latest.current.onAction({ type: 'selectSize', sizeId: size.id });
  }, []);
  const toggleSet = useCallback((index: number) => {
    const { options: current, selectedSetIds: selected } = latest.current;
    const set = current.sets[index];
    if (!set) return;
    // A board always has holds: the last one picked stays.
    if (selected.has(set.id) && pickedSetCount(current, selected) <= 1) return;
    latest.current.onAction({ type: 'toggleSet', setId: set.id });
  }, []);
  const pickAngle = useCallback((index: number) => {
    const next = latest.current.options.angles[index];
    if (next !== undefined) latest.current.onAction({ type: 'selectAngle', angle: next });
  }, []);

  const layoutRow = useMemo(() => {
    const actions: AppMenuAction[] = options.layouts.map((layout) => ({
      label: setupLayoutLabel(boardName, layout),
      selected: layout.id === layoutId,
    }));
    const current = options.layouts.find((layout) => layout.id === layoutId);
    return { actions, value: current ? setupLayoutLabel(boardName, current) : '' };
  }, [options.layouts, layoutId, boardName]);

  const sizeRow = useMemo(() => {
    const actions: AppMenuAction[] = options.sizes.map((size) => ({
      label: setupSizeLabel(size),
      selected: size.id === sizeId,
    }));
    const current = options.sizes.find((size) => size.id === sizeId);
    return { actions, value: current ? setupSizeLabel(current) : '' };
  }, [options.sizes, sizeId]);

  const holdsRow = useMemo(() => {
    const picked = pickedSetCount(options, selectedSetIds);
    const actions: AppMenuAction[] = options.sets.map((set) => {
      const selected = selectedSetIds.has(set.id);
      return { label: set.name, selected, disabled: selected && picked <= 1 };
    });
    const value = options.sets
      .filter((set) => selectedSetIds.has(set.id))
      .map((set) => set.name)
      .join(', ');
    return { actions, value };
  }, [options, selectedSetIds]);

  const angleRow = useMemo(
    () =>
      angleIsFixed
        ? {
            actions: options.angles.map((option): AppMenuAction => ({
              label: setupAngleLabel(option),
              selected: option === angle,
            })),
            value: setupAngleLabel(angle),
          }
        : null,
    [angleIsFixed, options.angles, angle],
  );

  return (
    <View
      pointerEvents={disabled ? 'none' : 'auto'}
      accessibilityState={{ disabled }}
      style={disabled ? styles.locked : undefined}
      testID="setup-suggestion-fields"
    >
      <InsetGroupedList separatorInset="gutter">
        <SetupMenuRow
          key="layout"
          label={t('mobile.custom.layout')}
          value={layoutRow.value || choose}
          actions={layoutRow.actions}
          onSelectIndex={pickLayout}
          testID="setup-suggestion-layout"
        />
        <SetupMenuRow
          key="size"
          label={t('mobile.custom.size')}
          value={sizeRow.value || choose}
          actions={sizeRow.actions}
          onSelectIndex={pickSize}
          testID="setup-suggestion-size"
        />
        <SetupMenuRow
          key="holds"
          label={t('mobile.setupSuggestion.holds')}
          value={holdsRow.value || choose}
          actions={holdsRow.actions}
          onSelectIndex={toggleSet}
          testID="setup-suggestion-holds"
        />
        {angleRow ? (
          <SetupMenuRow
            key="angle"
            label={t('mobile.custom.angle')}
            value={angleRow.value}
            actions={angleRow.actions}
            onSelectIndex={pickAngle}
            testID="setup-suggestion-angle"
          />
        ) : null}
      </InsetGroupedList>
    </View>
  );
}

/** How many of this size's sets are picked; ids from another size don't count. */
function pickedSetCount(options: SetupSelectionOptions, selected: Set<number>): number {
  let count = 0;
  for (const set of options.sets) if (selected.has(set.id)) count += 1;
  return count;
}

type SetupMenuRowProps = {
  label: string;
  value: string;
  actions: AppMenuAction[];
  onSelectIndex: (index: number) => void;
  testID: string;
};

/**
 * One row: the label, and a native menu whose anchor reads the value. Memoised
 * so a pick in one row leaves the others alone.
 */
const SetupMenuRow = memo(function SetupMenuRow({ label, value, actions, onSelectIndex, testID }: SetupMenuRowProps) {
  return (
    <View style={[insetGroupedRowStyles.row, styles.row]} testID={testID}>
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
      />
    </View>
  );
});

const styles = StyleSheet.create({
  row: {
    flexWrap: 'wrap',
    justifyContent: 'space-between',
  },
  label: {
    flexShrink: 1,
  },
  locked: { opacity: 0.5 },
});
