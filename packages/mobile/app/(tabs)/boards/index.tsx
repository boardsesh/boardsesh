import { useState, useEffect } from 'react';
import { View, ScrollView, StyleSheet } from 'react-native';
import { useRouter } from 'expo-router';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { UserBoard } from '@boardsesh/shared-schema';
import { useMyBoards, useSearchBoards } from '../../../src/lib/graphql/hooks';
import { useAuth } from '../../../src/providers/auth-provider';
import { useTheme, type ResolvedSystemColors } from '../../../src/providers/theme-provider';
import { setStoredBoardConfig, getStoredBoardConfig } from '../../../src/lib/board-store';
import { hapticSelection } from '../../../src/lib/haptics';
import { Text } from '../../../src/components/Text';
import { Card } from '../../../src/components/Card';
import { Icon } from '../../../src/components/Icon';
import { ActivityIndicator } from '../../../src/components/ActivityIndicator';
import { brandColors } from '../../../src/theme/colors';
import { spacing } from '../../../src/theme/tokens';

const ANON_BOARD_LIMIT = 20;

export default function BoardSelection() {
  const { isAuthenticated, isLoading: authLoading } = useAuth();

  if (authLoading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" />
      </View>
    );
  }

  return isAuthenticated ? <MyBoardsList /> : <PublicBoardsList />;
}

function MyBoardsList() {
  const { data: boardConnection, isLoading } = useMyBoards();
  const boards = boardConnection?.boards ?? [];
  const { t } = useTranslation('boards');

  return (
    <BoardsListView
      boards={boards}
      isLoading={isLoading}
      emptyTitle={t('mobile.emptyTitle')}
      emptySubtitle={t('mobile.emptySubtitle')}
    />
  );
}

function PublicBoardsList() {
  const { data: boardConnection, isLoading } = useSearchBoards({ limit: ANON_BOARD_LIMIT });
  const boards = boardConnection?.boards ?? [];
  const { t } = useTranslation('auth');

  return (
    <BoardsListView
      boards={boards}
      isLoading={isLoading}
      emptyTitle={t('nativeStart.prompt.boardsPickerTitle')}
      emptySubtitle={t('nativeStart.prompt.boardsPickerDescription')}
    />
  );
}

type BoardsListViewProps = {
  boards: UserBoard[];
  isLoading: boolean;
  emptyTitle: string;
  emptySubtitle: string;
};

function BoardsListView({ boards, isLoading, emptyTitle, emptySubtitle }: BoardsListViewProps) {
  const { systemColors } = useTheme();
  const router = useRouter();
  const queryClient = useQueryClient();

  const [activeBoardUuid, setActiveBoardUuid] = useState<string | null>(null);

  useEffect(() => {
    getStoredBoardConfig().then((config) => {
      if (config) setActiveBoardUuid(config.boardUuid);
    });
  }, []);

  const handleBoardPress = async (board: UserBoard) => {
    hapticSelection();
    await setStoredBoardConfig({
      boardUuid: board.uuid,
      boardName: board.boardType,
      layoutId: board.layoutId,
      sizeId: board.sizeId,
      setIds: board.setIds,
      angle: board.angle,
    });
    setActiveBoardUuid(board.uuid);
    queryClient.setQueryData(['defaultBoard'], { defaultBoard: board });
    router.navigate('/(tabs)/climbs');
  };

  if (isLoading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" />
      </View>
    );
  }

  if (boards.length === 0) {
    return (
      <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.centered}>
        <Text variant="headline" style={styles.emptyTitle}>
          {emptyTitle}
        </Text>
        <Text variant="subheadline" style={styles.emptySubtitle}>
          {emptySubtitle}
        </Text>
      </ScrollView>
    );
  }

  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" style={styles.flex} contentContainerStyle={styles.container}>
      {boards.map((board) => {
        const isActive = board.uuid === activeBoardUuid;

        return (
          <Card key={board.uuid} onPress={() => handleBoardPress(board)} style={cardStyle(systemColors, isActive)}>
            <View style={styles.cardContent}>
              <View style={styles.cardTextContent}>
                <Text variant="headline">{board.name}</Text>
                <Text variant="subheadline" style={styles.cardSubtitle}>
                  {board.boardType} · {board.sizeName ?? ''}
                </Text>
              </View>
              {isActive && <Icon name="tick" size={22} color={brandColors.primary} />}
            </View>
          </Card>
        );
      })}
    </ScrollView>
  );
}

function cardStyle(systemColors: ResolvedSystemColors, isActive: boolean) {
  return {
    backgroundColor: systemColors.secondaryBackground,
    borderWidth: isActive ? 2 : StyleSheet.hairlineWidth,
    borderColor: isActive ? brandColors.primary : systemColors.separator,
  } as const;
}

const styles = StyleSheet.create({
  flex: {
    flex: 1,
  },
  container: {
    padding: spacing[4],
    gap: spacing[3],
  },
  centered: {
    flexGrow: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing[4],
  },
  emptyTitle: {
    opacity: 0.6,
    textAlign: 'center',
  },
  emptySubtitle: {
    marginTop: spacing[2],
    opacity: 0.4,
    textAlign: 'center',
  },
  cardContent: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  cardTextContent: {
    flex: 1,
  },
  cardSubtitle: {
    marginTop: spacing[1],
    opacity: 0.6,
  },
});
