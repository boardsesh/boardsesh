import { ScrollView, StyleSheet, View } from 'react-native';
import { holdIdToCoordinate } from '@boardsesh/board-config';
import type { BoardName } from '@boardsesh/shared-schema';
import { LedDot } from '../ui/LedDot';
import { Text } from '../ui/Text';
import { holdLeds } from '../ui/theme';
import { spacing } from '../ui/tokens';
import { getBoardGeometry, litHolds, type HoldRole } from './board-geometry';

const ROLE_ORDER: HoldRole[] = ['start', 'hand', 'finish', 'foot'];
const ROLE_NAMES: Record<HoldRole, [string, string]> = {
  start: ['start', 'starts'],
  hand: ['hand', 'hands'],
  finish: ['finish', 'finishes'],
  foot: ['foot', 'feet'],
};

type HoldLegendProps = {
  board: { boardName: BoardName; layoutId: number; sizeId: number; setIds: number[] };
  frames: string;
  /** Keep to one line, sliding sideways when it's long, so it never changes height. */
  singleLine?: boolean;
};

/** Each role's LED colour with its holds: coordinates on a MoonBoard, counts elsewhere. */
export function HoldLegend({ board, frames, singleLine = false }: HoldLegendProps) {
  const geometry = getBoardGeometry(board);
  if (!geometry) return null;
  const holds = litHolds(geometry, board.boardName, frames);
  const leds = holdLeds(board.boardName);
  const groups = ROLE_ORDER.map((role) => {
    const ids = holds.filter((hold) => hold.role === role).map((hold) => hold.id);
    const text = geometry.grid
      ? ids.map((id) => holdIdToCoordinate(id)).join(' ')
      : `${ids.length} ${ROLE_NAMES[role][ids.length === 1 ? 0 : 1]}`;
    return { role, count: ids.length, text };
  }).filter((group) => group.count > 0);

  const items = groups.map((group) => (
    <View key={group.role} style={styles.group}>
      <LedDot color={leds[group.role]} />
      <Text variant="mono" tone="secondary" style={styles.text}>
        {group.text}
      </Text>
    </View>
  ));

  if (singleLine) {
    return (
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={[styles.legend, styles.singleLine]}
      >
        {items}
      </ScrollView>
    );
  }
  return <View style={styles.legend}>{items}</View>;
}

const styles = StyleSheet.create({
  legend: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
    columnGap: 14,
    rowGap: 6,
    paddingHorizontal: spacing.sm,
  },
  // Centred while it fits, scrollable once it doesn't.
  singleLine: { flexWrap: 'nowrap', flexGrow: 1 },
  group: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  text: { fontSize: 10, lineHeight: 13, letterSpacing: 0.3 },
});
