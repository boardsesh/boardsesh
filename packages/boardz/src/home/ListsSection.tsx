import { Pressable, StyleSheet, View } from 'react-native';
import { router } from 'expo-router';
import { useBoard } from '../board/board-provider';
import { ListCard } from '../lists/ListCard';
import { climbsForBoard, FAVOURITES_ID, PROJECTS_ID, type ClimbList } from '../lists/lists';
import { useLists } from '../lists/lists-provider';
import { Icon } from '../ui/Icon';
import { ChevronRight } from '../ui/icons';
import { Text } from '../ui/Text';
import { useTheme } from '../ui/theme';
import { spacing } from '../ui/tokens';

/** Favourites and Projects on Home, a tap from their climbs. */
export function ListsSection() {
  const theme = useTheme();
  const { board } = useBoard();
  const { lists } = useLists();
  const openList = (list: ClimbList) => router.push({ pathname: '/home/lists/[id]', params: { id: list.id } });

  return (
    <View style={styles.group}>
      <View style={styles.header}>
        <Text variant="label" accessibilityRole="header">
          Lists
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`All lists, ${lists.length}`}
          hitSlop={spacing.sm}
          onPress={() => router.push('/home/lists')}
          style={styles.all}
        >
          <Text variant="label" tone="secondary">
            All lists
          </Text>
          <Icon icon={ChevronRight} size={12} color={theme.fg2} />
        </Pressable>
      </View>
      <View style={styles.cards}>
        {lists
          .filter((list) => list.id === FAVOURITES_ID || list.id === PROJECTS_ID)
          .map((list) => (
            <ListCard
              key={list.id}
              list={list}
              climbs={board ? climbsForBoard(list, board) : list.climbs}
              onPress={() => openList(list)}
            />
          ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  group: { gap: spacing.sm },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 2 },
  all: { flexDirection: 'row', alignItems: 'center', gap: 2 },
  cards: { flexDirection: 'row', gap: 10 },
});
