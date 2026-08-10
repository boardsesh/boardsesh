// The one row shape both tick sheets are built from.
//
// It owns the horizontal gutter, the label column, the 56pt beat, the
// leading-inset hairline and the disabled treatment — deliberately, because the
// alternative is what shipped before: every picker brought its own padding and
// the sheet's left edge stepped 72 / 88 / 98pt down the form. A child rendered
// into `children` must NOT add horizontal padding of its own; if it needs to
// bleed to the screen edge (a scroll rail), the row does that for it via
// `bleed`.
import React, { type ReactNode } from 'react';
import { StyleSheet, View, useWindowDimensions } from 'react-native';
import { Text } from '../Text';
import { useTheme } from '../../providers/theme-provider';
import {
  TICK_CONTROL_ORIGIN,
  TICK_GUTTER,
  TICK_LABEL_GAP,
  TICK_LABEL_MIN_WIDTH,
  TICK_ROW_HEIGHT,
  TICK_STACK_FONT_SCALE,
} from './tick-sheet-metrics';

type TickFormRowProps = {
  label: string;
  children: ReactNode;
  /** Row height override — rail rows and the angle row are taller. */
  height?: number;
  /** Let the control run to the screen edge (a horizontal rail), dropping the
   *  row's trailing gutter so the rail reads as scrollable rather than clipped. */
  bleed?: boolean;
  /** Dim + inert, without unmounting: the edit sheet's Tries row when the tick
   *  is a flash. Keeping the row mounted preserves the form's vertical rhythm
   *  and the control's state. */
  disabled?: boolean;
  /** Hairline below the row, inset to the control seam. Rows opt out when they
   *  are the last in a group. */
  showSeparator?: boolean;
  testID?: string;
};

export const TickFormRow = React.memo(function TickFormRow({
  label,
  children,
  height,
  bleed = false,
  disabled = false,
  showSeparator = true,
  testID,
}: TickFormRowProps) {
  const { systemColors, spacing, opacity } = useTheme();
  // Reactive OS text scale — this re-renders when the user changes their text
  // size, unlike a one-shot JS breakpoint read.
  const { fontScale } = useWindowDimensions();
  const stacked = fontScale > TICK_STACK_FONT_SCALE;

  const dimmed = disabled ? { opacity: opacity.disabled } : undefined;

  return (
    <View testID={testID}>
      <View
        style={[
          styles.row,
          {
            paddingRight: bleed ? 0 : TICK_GUTTER,
            minHeight: height ?? TICK_ROW_HEIGHT,
            gap: stacked ? spacing[2] : TICK_LABEL_GAP,
          },
          stacked ? styles.rowStacked : null,
        ]}
      >
        <Text variant="body" color={systemColors.secondaryLabel} numberOfLines={2} style={[styles.label, dimmed]}>
          {label}
        </Text>
        <View
          pointerEvents={disabled ? 'none' : 'auto'}
          style={[styles.control, stacked ? styles.controlStacked : null, dimmed]}
        >
          {children}
        </View>
      </View>
      {showSeparator ? (
        <View
          style={[
            styles.separator,
            {
              borderBottomColor: systemColors.separator,
              // Stacked, the control no longer starts at the seam — it starts at
              // the gutter — so a seam-inset hairline would float detached under
              // it. Same flag drives both.
              marginLeft: stacked ? TICK_GUTTER : TICK_CONTROL_ORIGIN,
            },
          ]}
        />
      ) : null}
    </View>
  );
});

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingLeft: TICK_GUTTER,
  },
  rowStacked: {
    flexDirection: 'column',
    alignItems: 'flex-start',
  },
  label: {
    // A floor, not a fixed width: a longer translation grows the column and the
    // control seam moves with it rather than clipping the label.
    minWidth: TICK_LABEL_MIN_WIDTH,
    flexShrink: 0,
  },
  control: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
  },
  controlStacked: {
    // Stacked, the control owns the full width and sizes to its own content —
    // flex:1 in a column would stretch it vertically instead.
    flex: 0,
    alignSelf: 'stretch',
  },
  separator: {
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
});
