import { memo, useCallback, useMemo, type ComponentType } from 'react';
import { FlatList, StyleSheet, View, type FlatListProps } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Icon } from '../Icon';
import { PressableSurface } from '../PressableSurface';
import { SwitchRow } from '../SwitchRow';
import { announceQueued } from '../../lib/announce-queued';
import { hapticSelection } from '../../lib/haptics';
import type { SectionMoveDirection } from '../../lib/section-layout';
import { useTheme } from '../../providers/theme-provider';
import { borderRadius, spacing } from '../../theme/tokens';

export type SectionLayoutRowModel<Id extends string> = {
  id: Id;
  label: string;
  description?: string;
  visible: boolean;
  /** False for a row that keeps its place: a switch and no arrows. Rows with arrows sit together. */
  movable: boolean;
};

/** Returns `false` when it refuses the move, so the row stays quiet: no haptic, nothing said. */
export type SectionMoveHandler<Id extends string> = (sectionId: Id, direction: SectionMoveDirection) => boolean | void;

export type PlacedSectionLayoutRow<Id extends string> = SectionLayoutRowModel<Id> & {
  /** Ends of the row's group. Rows with arrows form one group, switch-only rows another. */
  first: boolean;
  last: boolean;
  /** A group that follows another one starts with a gap. */
  gapAbove: boolean;
  /** Place among the rows with arrows, from 1, and how many there are. 0 for a switch-only row. */
  position: number;
  movableCount: number;
  canMoveUp: boolean;
  canMoveDown: boolean;
};

/** Where each row sits, and which way its arrows can go. */
export function placeSectionLayoutRows<Id extends string>(
  rows: readonly SectionLayoutRowModel<Id>[],
): PlacedSectionLayoutRow<Id>[] {
  const movableCount = rows.filter((row) => row.movable).length;
  let position = 0;
  return rows.map((row, index) => {
    const previous = rows[index - 1];
    const next = rows[index + 1];
    const first = previous === undefined || previous.movable !== row.movable;
    const last = next === undefined || next.movable !== row.movable;
    if (row.movable) position += 1;
    return {
      ...row,
      first,
      last,
      gapAbove: first && index > 0,
      position: row.movable ? position : 0,
      movableCount,
      canMoveUp: row.movable && !first,
      canMoveDown: row.movable && !last,
    };
  });
}

// Two 44-point arrows after a small inset; the separator lines up with the label after them.
const ARROW_SIZE = 44;
const ARROWS_INSET = spacing[2];
const MOVABLE_SEPARATOR_INSET = ARROWS_INSET + ARROW_SIZE * 2 + spacing[4];

type RowProps<Id extends string> = PlacedSectionLayoutRow<Id> & {
  disabled: boolean;
  onVisibleChange: (sectionId: Id, visible: boolean) => void;
  onMove: SectionMoveHandler<Id>;
};

function SectionLayoutRowBase<Id extends string>({
  id,
  label,
  description,
  visible,
  movable,
  first,
  last,
  gapAbove,
  position,
  movableCount,
  canMoveUp,
  canMoveDown,
  disabled,
  onVisibleChange,
  onMove,
}: RowProps<Id>) {
  const { t } = useTranslation('common');
  const { systemColors, brandColors } = useTheme();
  const handleVisibleChange = useCallback((next: boolean) => onVisibleChange(id, next), [id, onVisibleChange]);
  const move = useCallback(
    (direction: SectionMoveDirection) => {
      if (disabled || !(direction < 0 ? canMoveUp : canMoveDown)) return;
      if (onMove(id, direction) === false) return;
      hapticSelection();
      // The row moves under the screen reader's focus; say where it landed.
      announceQueued(
        t('mobile.settings.sectionLayout.moved', {
          section: label,
          position: position + direction,
          count: movableCount,
        }),
      );
    },
    [disabled, canMoveUp, canMoveDown, id, label, position, movableCount, onMove, t],
  );
  const moveUp = useCallback(() => move(-1), [move]);
  const moveDown = useCallback(() => move(1), [move]);
  return (
    <View
      style={[
        styles.row,
        { backgroundColor: systemColors.secondaryBackground },
        first && styles.firstRow,
        last && styles.lastRow,
        gapAbove && styles.gapAbove,
      ]}
    >
      <View style={styles.content}>
        {movable ? (
          <View style={styles.arrows}>
            <PressableSurface
              onPress={moveUp}
              disabled={disabled || !canMoveUp}
              feedback="opacity"
              accessibilityLabel={t('mobile.settings.sectionLayout.moveUp', { section: label })}
              style={styles.arrow}
              testID={`section-layout-move-up-${id}`}
            >
              {/* PressableSurface dims a disabled arrow; the glyph keeps one colour. */}
              <Icon name="arrow.up" size={20} color={brandColors.primary} />
            </PressableSurface>
            <PressableSurface
              onPress={moveDown}
              disabled={disabled || !canMoveDown}
              feedback="opacity"
              accessibilityLabel={t('mobile.settings.sectionLayout.moveDown', { section: label })}
              style={styles.arrow}
              testID={`section-layout-move-down-${id}`}
            >
              <Icon name="arrow.down" size={20} color={brandColors.primary} />
            </PressableSurface>
          </View>
        ) : null}
        <View style={styles.switch}>
          <SwitchRow
            label={label}
            description={description}
            wrapDescription
            value={visible}
            onValueChange={handleVisibleChange}
            disabled={disabled}
          />
        </View>
      </View>
      {!last ? (
        <View
          style={[
            styles.separator,
            { backgroundColor: systemColors.separator, marginLeft: movable ? MOVABLE_SEPARATOR_INSET : spacing[4] },
          ]}
        />
      ) : null}
    </View>
  );
}

/** One row: a switch, plus ↑/↓ arrows (44 points, disabled at the ends) when it can move. */
const SectionLayoutRow = memo(SectionLayoutRowBase) as typeof SectionLayoutRowBase;

function keyOfRow(row: { id: string }): string {
  return row.id;
}

// Every list prop but the three the list owns passes straight through, so a sheet
// or a page never has to edit this component for its own list needs.
type SectionLayoutListProps<Id extends string> = Omit<
  FlatListProps<PlacedSectionLayoutRow<Id>>,
  'data' | 'renderItem' | 'keyExtractor'
> & {
  /** In the order to draw: switch-only rows (if any) as their own group, the rows with arrows together. */
  rows: readonly SectionLayoutRowModel<Id>[];
  /** Greys every switch and arrow out, such as while a stored layout still loads. */
  disabled?: boolean;
  onVisibleChange: (sectionId: Id, visible: boolean) => void;
  onMove: SectionMoveHandler<Id>;
  /** The list to render into: `BottomSheetFlatList` inside a sheet, React Native's `FlatList` elsewhere. */
  ListComponent?: ComponentType<FlatListProps<PlacedSectionLayoutRow<Id>>>;
};

/**
 * Show, hide and order sections: one grouped list of switch rows with ↑/↓
 * arrows. Arrows rather than drag handles, so reordering never fights the
 * sheet's own pan, works at large text and in the browser, and each move is a
 * plain screen-reader button.
 */
export function SectionLayoutList<Id extends string>({
  rows,
  disabled = false,
  onVisibleChange,
  onMove,
  ListComponent = FlatList,
  ...listProps
}: SectionLayoutListProps<Id>) {
  const placedRows = useMemo(() => placeSectionLayoutRows(rows), [rows]);
  const renderItem = useCallback(
    ({ item }: { item: PlacedSectionLayoutRow<Id> }) => (
      <SectionLayoutRow {...item} disabled={disabled} onVisibleChange={onVisibleChange} onMove={onMove} />
    ),
    [disabled, onVisibleChange, onMove],
  );
  return (
    <ListComponent
      showsVerticalScrollIndicator={false}
      {...listProps}
      data={placedRows}
      renderItem={renderItem}
      keyExtractor={keyOfRow}
    />
  );
}

const styles = StyleSheet.create({
  row: { overflow: 'hidden' },
  firstRow: { borderTopLeftRadius: borderRadius.lg, borderTopRightRadius: borderRadius.lg },
  lastRow: { borderBottomLeftRadius: borderRadius.lg, borderBottomRightRadius: borderRadius.lg },
  gapAbove: { marginTop: spacing[4] },
  content: { flexDirection: 'row', alignItems: 'center' },
  arrows: { flexDirection: 'row', paddingLeft: ARROWS_INSET },
  arrow: { width: ARROW_SIZE, height: ARROW_SIZE, alignItems: 'center', justifyContent: 'center' },
  switch: { flex: 1 },
  separator: { height: StyleSheet.hairlineWidth },
});
