import { Alert, ScrollView, StyleSheet, View } from 'react-native';
import { router } from 'expo-router';
import { useBoard } from '../../../../src/board/board-provider';
import { ListCard } from '../../../../src/lists/ListCard';
import { climbsForBoard, type ClimbList } from '../../../../src/lists/lists';
import { useLists } from '../../../../src/lists/lists-provider';
import { Button } from '../../../../src/ui/Button';
import { Plus } from '../../../../src/ui/icons';
import { Text } from '../../../../src/ui/Text';
import { useTheme } from '../../../../src/ui/theme';
import { TopBar } from '../../../../src/ui/TopBar';
import { GUTTER, spacing } from '../../../../src/ui/tokens';

export default function ListsScreen() {
  const theme = useTheme();
  const { board } = useBoard();
  const { lists, create } = useLists();

  const openList = (id: string) => router.push({ pathname: '/home/lists/[id]', params: { id } });
  const newList = () =>
    Alert.prompt(
      'New list',
      'Warm-ups, comp prep, the circuit you do on Tuesdays.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Create',
          onPress: (name?: string) => {
            const trimmed = name?.trim();
            if (trimmed) openList(create(trimmed));
          },
        },
      ],
      'plain-text',
    );

  const rows: ClimbList[][] = [];
  for (let index = 0; index < lists.length; index += 2) rows.push(lists.slice(index, index + 2));

  return (
    <View style={[styles.flex, { backgroundColor: theme.bgApp }]}>
      <TopBar label="Lists" />
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.titleRow}>
          <View style={styles.flex}>
            <Text variant="title1" accessibilityRole="header">
              Lists
            </Text>
            <Text variant="small" tone="tertiary">
              Kept on this phone.
            </Text>
          </View>
          <Button title="New list" variant="secondary" size="sm" icon={Plus} onPress={newList} />
        </View>
        {rows.map((row) => (
          <View key={row[0].id} style={styles.row}>
            {row.map((list) => (
              <ListCard
                key={list.id}
                list={list}
                climbs={board ? climbsForBoard(list, board) : list.climbs}
                onPress={() => openList(list.id)}
              />
            ))}
            {row.length === 1 ? <View style={styles.flex} /> : null}
          </View>
        ))}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  content: { paddingHorizontal: GUTTER, paddingTop: spacing.xs, paddingBottom: spacing.xxxl, gap: 10 },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, marginBottom: spacing.sm },
  row: { flexDirection: 'row', gap: 10 },
});
