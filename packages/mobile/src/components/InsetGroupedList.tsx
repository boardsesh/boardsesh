import { Children, Fragment, isValidElement, useMemo, type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { Card } from './Card';
import { useTheme } from '../providers/theme-provider';
import { cardCorners, spacing } from '../theme/tokens';
import { ART_SLOTS, ROW_ART_GAP, ROW_GUTTER, artRowTextStart, type ArtSize } from './art-slot';

/**
 * The parts of an inset-grouped row, for a row that is not an `ArtRow` (a timer,
 * an icon and a plain label). Each row owns the card's 16pt gutter, so the whole
 * width of the card is the tap target.
 */
export const insetGroupedRowStyles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: ROW_ART_GAP,
    paddingHorizontal: ROW_GUTTER,
    paddingVertical: spacing[3],
    minHeight: spacing[12],
  },
  /** The leading column of a regular row: 44pt wide, so its text lines up with the art rows'. */
  leading: {
    width: ART_SLOTS.regular.width,
    flexShrink: 0,
    alignItems: 'center',
  },
  text: {
    flex: 1,
    minWidth: 0,
    gap: spacing[1],
  },
});

export type InsetGroupedListProps = {
  /** One element per row. `null` and `false` are skipped, so a row can be conditional. */
  children: ReactNode;
  /**
   * Where the hairlines between rows start: at the text after a `regular` or
   * `compact` art slot, or at the 16pt `gutter` for rows with no art.
   */
  separatorInset?: ArtSize | 'gutter';
  testID?: string;
};

const SEPARATOR_INSETS = {
  compact: artRowTextStart('compact'),
  regular: artRowTextStart('regular'),
  large: artRowTextStart('large'),
  gutter: ROW_GUTTER,
} as const satisfies Record<ArtSize | 'gutter', number>;

/**
 * An inset-grouped card of rows (HIG Lists and tables, "inset grouped"): the
 * theme's `Card`, rows that run to its edges and own its gutter, and a hairline
 * between each pair inset to where the text starts. Pair it with `ArtRow`.
 *
 * The rows are clipped to the card's corners, so a selected row's fill or an
 * Android ripple never squares them off, while the card keeps its shadow.
 */
export function InsetGroupedList({ children, separatorInset = 'regular', testID }: InsetGroupedListProps) {
  const { systemColors } = useTheme();
  const separatorStyle = useMemo(
    () => [
      styles.separator,
      { marginStart: SEPARATOR_INSETS[separatorInset], backgroundColor: systemColors.separator },
    ],
    [separatorInset, systemColors.separator],
  );
  const rows = Children.toArray(children);
  return (
    <Card>
      <View style={styles.rows} testID={testID}>
        {rows.map((row, index) => (
          <Fragment key={isValidElement(row) && row.key !== null ? row.key : index}>
            {index > 0 ? <View style={separatorStyle} /> : null}
            {row}
          </Fragment>
        ))}
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  rows: {
    // Both Card variants inset their content by 16pt; the rows take it back.
    margin: -spacing[4],
    overflow: 'hidden',
    ...cardCorners,
  },
  separator: {
    height: StyleSheet.hairlineWidth,
  },
});
