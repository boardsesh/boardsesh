import { memo } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import type { Climb } from '@boardsesh/shared-schema';
import { gradeBand, gradeLabel, type GradeDisplayFormat } from '../grades/grades';
import { GradeBadge } from '../ui/GradeBadge';
import { Icon } from '../ui/Icon';
import { CircleCheck } from '../ui/icons';
import { Text } from '../ui/Text';
import { useTheme } from '../ui/theme';
import { GUTTER, ROW_HEIGHT } from '../ui/tokens';

/** "setter · 1,204 sends", for places that show a climb in a sentence. */
export function climbSubtitle(climb: Climb): string {
  const sends = `${climb.ascensionist_count.toLocaleString()} ${climb.ascensionist_count === 1 ? 'send' : 'sends'}`;
  return climb.setter_username ? `${climb.setter_username} · ${sends}` : sends;
}

/** A climb's quality, like "2.6", or null when it has none. */
export function climbQuality(climb: Climb): string | null {
  const stars = Number(climb.quality_average);
  return Number.isFinite(stars) && stars > 0 ? stars.toFixed(1) : null;
}

type ClimbRowProps = {
  climb: Climb;
  gradeFormat: GradeDisplayFormat;
  /** Sent by this climber at this angle: a check beside the grade. */
  sent: boolean;
  onPress: (climb: Climb) => void;
  /** More options for the climb, like taking it off a list. */
  onLongPress?: (climb: Climb) => void;
};

/** A problem row in the Graphite table: name, mono meta, grade in its band's colour. */
export const ClimbRow = memo(function ClimbRow({ climb, gradeFormat, sent, onPress, onLongPress }: ClimbRowProps) {
  const theme = useTheme();
  const label = gradeLabel(climb.difficulty, gradeFormat);
  const quality = climbQuality(climb);
  const isBenchmark = climb.benchmark_difficulty != null;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${climb.name}, ${label ?? 'ungraded'}${isBenchmark ? ', benchmark' : ''}${sent ? ', sent' : ''}`}
      accessibilityHint="Opens the climb and lights it on your board"
      onPress={() => onPress(climb)}
      onLongPress={onLongPress ? () => onLongPress(climb) : undefined}
      style={({ pressed }) => [
        styles.row,
        { borderBottomColor: theme.border1, backgroundColor: pressed ? theme.bgSurface2 : 'transparent' },
      ]}
    >
      <View style={styles.copy}>
        <Text variant="bodyStrong" numberOfLines={1} style={styles.name}>
          {climb.name}
        </Text>
        <View style={styles.meta}>
          {climb.setter_username ? (
            <Text variant="caption" tone="tertiary" numberOfLines={1} style={styles.setter}>
              {climb.setter_username}
            </Text>
          ) : null}
          <Text variant="mono" tone="tertiary">
            {climb.ascensionist_count.toLocaleString()}
          </Text>
          {quality ? (
            <Text variant="mono" tone="tertiary">
              ★{quality}
            </Text>
          ) : null}
        </View>
      </View>
      {sent ? <Icon icon={CircleCheck} size={18} color={theme.success} /> : null}
      <GradeBadge label={label} band={gradeBand(climb.difficulty)} benchmark={isBenchmark} fixedWidth />
    </Pressable>
  );
});

const styles = StyleSheet.create({
  row: {
    minHeight: ROW_HEIGHT,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: GUTTER,
    borderBottomWidth: 1,
  },
  copy: { flex: 1, minWidth: 0, gap: 4 },
  name: { fontSize: 16, letterSpacing: -0.24 },
  meta: { flexDirection: 'row', alignItems: 'center', gap: 7, overflow: 'hidden' },
  setter: { flexShrink: 1 },
});
