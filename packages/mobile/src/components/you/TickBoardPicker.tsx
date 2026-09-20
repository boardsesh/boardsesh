import { memo, useCallback, useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import { BottomSheetFlatList } from '@expo/ui/community/bottom-sheet';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { TICK_BOARD_OPTIONS, type TickBoardOption, type TickBoardOptionsResponse } from '@boardsesh/graphql/operations';
import { getLayoutName, getProductSize } from '@boardsesh/board-constants/product-sizes';
import { toBoardName } from '@boardsesh/board-config';
import { getHttpClient } from '../../lib/graphql/client';
import { screenshotModeNextPageParam } from '../../lib/screenshot-mode';
import { useTheme } from '../../providers/theme-provider';
import { Text } from '../Text';
import { Icon } from '../Icon';
import { PressableSurface } from '../PressableSurface';
import { ActivityIndicator } from '../ActivityIndicator';

type Choice = TickBoardOption | null;
const choiceKey = (board: Choice) => board?.uuid ?? 'none';

const BoardChoiceRow = memo(function BoardChoiceRow({
  board,
  selected,
  onSelect,
}: {
  board: Choice;
  selected: boolean;
  onSelect: (board: Choice) => void;
}) {
  const { t } = useTranslation('you');
  const { systemColors, spacing } = useTheme();
  const choose = useCallback(() => onSelect(board), [board, onSelect]);
  const boardName = toBoardName(board?.boardType);
  const detail =
    board && boardName
      ? [getLayoutName(boardName, board.layoutId), getProductSize(boardName, board.sizeId)?.name]
          .filter(Boolean)
          .join(' · ')
      : null;
  return (
    <PressableSurface
      onPress={choose}
      feedback="opacity"
      accessibilityRole="radio"
      accessibilityState={{ checked: selected }}
      accessibilityLabel={board?.name ?? t('mobile.logbook.boardNone')}
      style={[styles.row, { gap: spacing[3], padding: spacing[3] }]}
    >
      <Icon name="boards" size={22} color={systemColors.secondaryLabel} />
      <View style={styles.label}>
        <Text variant="body">{board?.name ?? t('mobile.logbook.boardNone')}</Text>
        {detail ? (
          <Text variant="footnote" color={systemColors.secondaryLabel}>
            {detail}
          </Text>
        ) : null}
      </View>
      {selected ? <Icon name="check.small" size={20} color={systemColors.label} /> : null}
    </PressableSurface>
  );
});

/** Inline body: changing sheet modes never displaces the edit sheet or its draft. */
export function TickBoardPicker({
  tickUuid,
  selection,
  onSelect,
  onBack,
}: {
  tickUuid: string;
  selection: Choice | undefined;
  onSelect: (board: Choice) => void;
  onBack: () => void;
}) {
  const { t } = useTranslation('you');
  const { systemColors, spacing } = useTheme();
  const query = useInfiniteQuery({
    queryKey: ['tickBoardOptions', tickUuid],
    initialPageParam: 0,
    queryFn: async ({ pageParam }) =>
      (
        await getHttpClient().request<TickBoardOptionsResponse>(TICK_BOARD_OPTIONS, {
          tickUuid,
          limit: 20,
          offset: pageParam,
        })
      ).tickBoardOptions,
    getNextPageParam: (lastPage, pages, lastOffset) =>
      screenshotModeNextPageParam(lastPage.hasMore ? lastOffset + 20 : undefined, pages.length),
  });
  const choices = useMemo<Choice[]>(() => {
    const boards = new Map<string, TickBoardOption>();
    for (const page of query.data?.pages ?? []) for (const board of page.boards) boards.set(board.uuid, board);
    return [null, ...boards.values()];
  }, [query.data]);
  const selectedUuid =
    selection === undefined
      ? query.data
        ? (query.data.pages[0]?.currentBoard?.uuid ?? 'none')
        : undefined
      : (selection?.uuid ?? 'none');
  const renderItem = useCallback(
    ({ item }: { item: Choice }) => (
      <BoardChoiceRow board={item} selected={choiceKey(item) === selectedUuid} onSelect={onSelect} />
    ),
    [onSelect, selectedUuid],
  );
  const loadMore = useCallback(() => {
    if (query.hasNextPage && !query.isFetching && !query.isFetchNextPageError) void query.fetchNextPage();
  }, [query.hasNextPage, query.isFetching, query.isFetchNextPageError, query.fetchNextPage]);
  const retry = useCallback(() => {
    if (query.isFetchNextPageError) void query.fetchNextPage();
    else void query.refetch();
  }, [query.isFetchNextPageError, query.fetchNextPage, query.refetch]);
  return (
    <View style={styles.body}>
      <PressableSurface
        onPress={onBack}
        accessibilityRole="button"
        style={[styles.row, { padding: spacing[3], gap: spacing[2] }]}
      >
        <Icon name="chevron.left" size={18} color={systemColors.label} />
        <Text>{t('mobile.logbook.boardBack')}</Text>
      </PressableSurface>
      <BottomSheetFlatList
        data={choices}
        keyExtractor={choiceKey}
        renderItem={renderItem}
        onEndReached={loadMore}
        onEndReachedThreshold={0.2}
        style={styles.list}
        ListFooterComponent={
          <View style={{ padding: spacing[3] }}>
            {query.isFetching ? <ActivityIndicator /> : null}
            {query.isError ? (
              <PressableSurface onPress={retry} accessibilityRole="button">
                <Text>{t('mobile.logbook.boardRetry')}</Text>
              </PressableSurface>
            ) : !query.isPending && choices.length === 1 ? (
              <Text color={systemColors.secondaryLabel}>{t('mobile.logbook.boardEmpty')}</Text>
            ) : null}
          </View>
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  body: { flex: 1 },
  list: { flex: 1 },
  row: { flexDirection: 'row', alignItems: 'center', minHeight: 48 },
  label: { flex: 1 },
});
