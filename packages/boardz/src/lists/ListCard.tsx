import { Pressable, StyleSheet, View } from 'react-native';
import { gradeBand, gradeLabel } from '../grades/grades';
import { usePreferences } from '../settings/preferences-provider';
import { Card } from '../ui/Card';
import { GradeBadge } from '../ui/GradeBadge';
import { Icon, type IconComponent } from '../ui/Icon';
import { Flame, Heart, List } from '../ui/icons';
import { Text } from '../ui/Text';
import { useTheme } from '../ui/theme';
import { radius, spacing } from '../ui/tokens';
import type { ClimbList, ListKind, SavedClimb } from './lists';

export const LIST_ICONS: Record<ListKind, IconComponent> = { favourites: Heart, projects: Flame, custom: List };

/** The list's icon on a quiet tile. */
export function ListIcon({ kind }: { kind: ListKind }) {
  const theme = useTheme();
  return (
    <View style={[styles.iconTile, { backgroundColor: theme.bgSurface3 }]}>
      <Icon icon={LIST_ICONS[kind]} size={16} color={theme.fg1} />
    </View>
  );
}

type ListCardProps = {
  list: ClimbList;
  /** The list's climbs that fit the board. */
  climbs: readonly SavedClimb[];
  onPress: () => void;
};

/** A list as a card: its icon, how many climbs, and the grades of the latest three. */
export function ListCard({ list, climbs, onPress }: ListCardProps) {
  const theme = useTheme();
  const { gradeFormat } = usePreferences();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${list.name}, ${climbs.length} ${climbs.length === 1 ? 'climb' : 'climbs'}`}
      onPress={onPress}
      style={({ pressed }) => [styles.flex, pressed && styles.pressed]}
    >
      <Card style={styles.card}>
        <View style={styles.top}>
          <ListIcon kind={list.kind} />
          <Text variant="mono" color={theme.fg3} monospacedDigits>
            {String(climbs.length).padStart(2, '0')}
          </Text>
        </View>
        <View style={styles.bottom}>
          <Text variant="bodyStrong" numberOfLines={1}>
            {list.name}
          </Text>
          {climbs.length > 0 ? (
            <View style={styles.grades}>
              {climbs.slice(0, 3).map((saved) => (
                <GradeBadge
                  key={saved.climb.uuid}
                  label={gradeLabel(saved.climb.difficulty, gradeFormat)}
                  band={gradeBand(saved.climb.difficulty)}
                  size="sm"
                />
              ))}
            </View>
          ) : (
            <Text variant="small" tone="tertiary" numberOfLines={1} style={styles.empty}>
              Nothing saved yet
            </Text>
          )}
        </View>
      </Card>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  pressed: { opacity: 0.7 },
  card: { gap: spacing.lg, padding: 14 },
  top: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  iconTile: { width: 32, height: 32, borderRadius: radius.tag, alignItems: 'center', justifyContent: 'center' },
  bottom: { gap: spacing.sm },
  grades: { flexDirection: 'row', gap: 4, height: 26 },
  empty: { lineHeight: 26 },
});
