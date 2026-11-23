import { memo, useMemo, type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTheme } from '../../providers/theme-provider';
import { borderRadius, spacing } from '../../theme/tokens';
import { selectByVariant } from '../../theme/variants/select-by-variant';
import { artRowTextStart, type ArtSize } from '../art-slot';
import type { GroupedCellPosition } from './gym-page-view-model';

type InsetGroupedCellProps = {
  position: GroupedCellPosition;
  /** Where the hairline above a row starts: at the text after its art. */
  separatorInset: ArtSize;
  /** Space after the card's last row, before whatever follows it (a shelf's 28pt). */
  endGap?: number;
  children: ReactNode;
};

/**
 * One row of an inset-grouped card, drawn as its own list cell. `InsetGroupedList`
 * wraps every row in one `Card`, which a virtualized list can't do: its rows are
 * separate cells. This draws the same card in slices (the card surface and its
 * hairline edge, rounded at the first and last row, a hairline between rows
 * inset to the text), so a long board list scrolls cell by cell and still reads
 * as one card. It draws no shadow: a shadow per slice would mark every seam.
 */
export const InsetGroupedCell = memo(function InsetGroupedCell({
  position,
  separatorInset,
  endGap = 0,
  children,
}: InsetGroupedCellProps) {
  const { variant, systemColors, m3 } = useTheme();
  // The card's own surface: the elevated M3 card on Material, the grouped card elsewhere.
  const surfaceStyle = useMemo(
    () =>
      selectByVariant(variant, {
        material: { backgroundColor: m3.elevation.level1, borderColor: m3.outlineVariant },
        liquidGlass: { backgroundColor: systemColors.secondaryBackground, borderColor: systemColors.separator },
      }),
    [variant, m3.elevation.level1, m3.outlineVariant, systemColors.secondaryBackground, systemColors.separator],
  );
  const separatorStyle = useMemo(
    () => [styles.separator, { marginStart: artRowTextStart(separatorInset), backgroundColor: systemColors.separator }],
    [separatorInset, systemColors.separator],
  );
  const hasRowAbove = position === 'middle' || position === 'last';
  const closesCard = position === 'last' || position === 'only';
  return (
    <View style={[styles.gutter, closesCard && endGap > 0 ? { paddingBottom: endGap } : null]}>
      <View style={[styles.cell, surfaceStyle, POSITION_STYLES[position]]}>
        {hasRowAbove ? <View style={separatorStyle} /> : null}
        {children}
      </View>
    </View>
  );
});

const styles = StyleSheet.create({
  gutter: {
    paddingHorizontal: spacing[4],
  },
  cell: {
    overflow: 'hidden',
    borderLeftWidth: StyleSheet.hairlineWidth,
    borderRightWidth: StyleSheet.hairlineWidth,
    borderCurve: 'continuous',
  },
  separator: {
    height: StyleSheet.hairlineWidth,
  },
});

const top = {
  borderTopWidth: StyleSheet.hairlineWidth,
  borderTopLeftRadius: borderRadius.lg,
  borderTopRightRadius: borderRadius.lg,
};
const bottom = {
  borderBottomWidth: StyleSheet.hairlineWidth,
  borderBottomLeftRadius: borderRadius.lg,
  borderBottomRightRadius: borderRadius.lg,
};

const POSITION_STYLES = StyleSheet.create({
  only: { ...top, ...bottom },
  first: top,
  middle: {},
  last: bottom,
});
