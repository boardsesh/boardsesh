import { ActionSheetIOS, Alert, StyleSheet, View } from 'react-native';
import { FlashList } from '@shopify/flash-list';
import { router, useLocalSearchParams } from 'expo-router';
import type { Climb } from '@boardsesh/shared-schema';
import { useBoard } from '../../../../src/board/board-provider';
import { ClimbRow } from '../../../../src/climbs/ClimbRow';
import { useClimbSequence } from '../../../../src/climbs/climb-sequence';
import { ListIcon } from '../../../../src/lists/ListCard';
import { climbsForBoard, type ListKind } from '../../../../src/lists/lists';
import { useLists } from '../../../../src/lists/lists-provider';
import { usePreferences } from '../../../../src/settings/preferences-provider';
import { useSentClimbs } from '../../../../src/ticks/use-sent-climbs';
import { IconButton } from '../../../../src/ui/IconButton';
import { Ellipsis } from '../../../../src/ui/icons';
import { Text } from '../../../../src/ui/Text';
import { useTheme } from '../../../../src/ui/theme';
import { TopBar } from '../../../../src/ui/TopBar';
import { GUTTER, spacing } from '../../../../src/ui/tokens';

const keyExtractor = (climb: Climb) => climb.uuid;

const EMPTY: Record<ListKind, [string, string]> = {
  favourites: ['No favourites yet', 'Tap the heart on a climb to keep it here.'],
  projects: ['No projects yet', 'Working on something? Save it here from the list button on a climb.'],
  custom: ['Nothing here yet', 'Add climbs with the list button on a climb.'],
};

export default function ListScreen() {
  const theme = useTheme();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { board } = useBoard();
  const { lists, removeFromList, rename, remove } = useLists();
  const { setClimbs } = useClimbSequence();
  const { gradeFormat } = usePreferences();
  const sentBefore = useSentClimbs(board);
  const list = lists.find((candidate) => candidate.id === id);

  if (!list) {
    return (
      <View style={[styles.flex, { backgroundColor: theme.bgApp }]}>
        <TopBar label="List" />
        <View style={styles.empty}>
          <Text variant="title3">This list is gone.</Text>
        </View>
      </View>
    );
  }

  const climbs = board ? climbsForBoard(list, board).map((saved) => saved.climb) : [];
  const elsewhere = list.climbs.length - climbs.length;
  const [emptyTitle, emptyBody] = EMPTY[list.kind];

  const openClimb = (climb: Climb) => {
    setClimbs(climbs);
    router.push({ pathname: '/climb/[uuid]', params: { uuid: climb.uuid } });
  };
  const climbOptions = (climb: Climb) => {
    if (!board) return;
    ActionSheetIOS.showActionSheetWithOptions(
      {
        title: climb.name,
        options: [`Remove from ${list.name}`, 'Cancel'],
        destructiveButtonIndex: 0,
        cancelButtonIndex: 1,
      },
      (choice) => {
        if (choice === 0) removeFromList(list.id, board.boardName, climb.uuid);
      },
    );
  };
  const listOptions = () =>
    ActionSheetIOS.showActionSheetWithOptions(
      {
        title: list.name,
        options: ['Rename', 'Delete list', 'Cancel'],
        destructiveButtonIndex: 1,
        cancelButtonIndex: 2,
      },
      (choice) => {
        if (choice === 0) {
          Alert.prompt(
            'Rename list',
            undefined,
            [
              { text: 'Cancel', style: 'cancel' },
              {
                text: 'Save',
                onPress: (name?: string) => {
                  if (name?.trim()) rename(list.id, name);
                },
              },
            ],
            'plain-text',
            list.name,
          );
        } else if (choice === 1) {
          Alert.alert(`Delete ${list.name}?`, 'The list goes; the climbs stay on the board.', [
            { text: 'Keep it', style: 'cancel' },
            {
              text: 'Delete',
              style: 'destructive',
              onPress: () => {
                router.back();
                remove(list.id);
              },
            },
          ]);
        }
      },
    );

  const header = (
    <View style={[styles.header, { borderBottomColor: theme.border2 }]}>
      <ListIcon kind={list.kind} />
      <View style={styles.headerCopy}>
        <Text variant="title1" numberOfLines={2} accessibilityRole="header">
          {list.name}
        </Text>
        <Text variant="label" tone="tertiary">
          {climbs.length} {climbs.length === 1 ? 'climb' : 'climbs'}
          {board ? ` · ${board.name}` : ''}
        </Text>
      </View>
    </View>
  );

  const footer = (
    <View style={styles.footer}>
      {climbs.length > 0 ? (
        <Text variant="small" tone="tertiary">
          Press and hold a climb to take it off this list.
        </Text>
      ) : null}
      {elsewhere > 0 ? (
        <Text variant="small" tone="tertiary">
          {elsewhere} more saved on another board. Switch boards on Home to see {elsewhere === 1 ? 'it' : 'them'}.
        </Text>
      ) : null}
    </View>
  );

  return (
    <View style={[styles.flex, { backgroundColor: theme.bgApp }]}>
      <TopBar
        label="List"
        right={
          list.kind === 'custom' ? (
            <IconButton icon={Ellipsis} label="List options" size="lg" onPress={listOptions} />
          ) : undefined
        }
      />
      <FlashList
        data={climbs}
        keyExtractor={keyExtractor}
        renderItem={({ item }) => (
          <ClimbRow
            climb={item}
            gradeFormat={gradeFormat}
            sent={sentBefore.has(item.uuid)}
            onPress={openClimb}
            onLongPress={climbOptions}
          />
        )}
        extraData={[sentBefore, gradeFormat]}
        ListHeaderComponent={header}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text variant="title3">{emptyTitle}</Text>
            <Text tone="tertiary" align="center">
              {emptyBody}
            </Text>
          </View>
        }
        ListFooterComponent={footer}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: GUTTER,
    paddingTop: spacing.xs,
    paddingBottom: spacing.lg,
    borderBottomWidth: 1,
  },
  headerCopy: { flex: 1, gap: 4 },
  footer: { gap: spacing.sm, paddingHorizontal: GUTTER, paddingTop: spacing.lg, paddingBottom: spacing.xxxl },
  empty: { alignItems: 'center', gap: spacing.sm, paddingVertical: 56, paddingHorizontal: spacing.xxl },
});
