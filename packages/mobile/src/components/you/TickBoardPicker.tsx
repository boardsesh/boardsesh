import { toBoardName } from '@boardsesh/board-config';
import { getLayoutName, getProductSize } from '@boardsesh/board-constants/product-sizes';
import { TICK_BOARD_OPTIONS, type TickBoardOption, type TickBoardOptionsResponse } from '@boardsesh/graphql/operations';
import { BottomSheetFlatList } from '@expo/ui/community/bottom-sheet';
import { useInfiniteQuery } from '@tanstack/react-query';
import { memo, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';
import { getHttpClient } from '../../lib/graphql/client';
import { useTheme } from '../../providers/theme-provider';
import { ActivityIndicator } from '../ActivityIndicator';
import { Icon } from '../Icon';
import { PressableSurface } from '../PressableSurface';
import { Text } from '../Text';

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
    getNextPageParam: (lastPage, _pages, lastOffset) => (lastPage.hasMore ? lastOffset + 20 : undefined),
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
  const loadMore = useCallback(() => {
    if (query.hasNextPage && !query.isFetching && !query.isFetchNextPageError) void query.fetchNextPage();
  }, [query.hasNextPage, query.isFetching, query.isFetchNextPageError, query.fetchNextPage]);
  const retry = useCallback(() => {
    if (query.isFetchNextPageError) void query.fetchNextPage();
    else void query.refetch();
  }, [query.isFetchNextPageError, query.fetchNextPage, query.refetch]);
  return (
    <TickBoardPickerView
      choices={choices}
      selectedUuid={selectedUuid}
      onSelect={onSelect}
      onBack={onBack}
      isFetching={query.isFetching}
      isError={query.isError}
      isPending={query.isPending}
      onLoadMore={loadMore}
      onRetry={retry}
    />
  );
}
export type TickBoardPickerViewProps = {
  choices: Choice[];
  selectedUuid: string | undefined;
  onSelect: (board: Choice) => void;
  onBack: () => void;
  isFetching: boolean;
  isError: boolean;
  isPending: boolean;
  onLoadMore: () => void;
  onRetry: () => void;
};
export function TickBoardPickerView({
  choices,
  selectedUuid,
  onSelect,
  onBack,
  isFetching,
  isError,
  isPending,
  onLoadMore,
  onRetry,
}: TickBoardPickerViewProps) {
  const { t } = useTranslation('you');
  const { systemColors, spacing } = useTheme();
  const renderItem = useCallback(
    ({ item }: { item: Choice }) => (
      <BoardChoiceRow board={item} selected={choiceKey(item) === selectedUuid} onSelect={onSelect} />
    ),
    [onSelect, selectedUuid],
  );
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
        onEndReached={onLoadMore}
        onEndReachedThreshold={0.2}
        style={styles.list}
        ListFooterComponent={
          <View style={{ padding: spacing[3] }}>
            {isFetching ? <ActivityIndicator /> : null}
            {isError ? (
              <PressableSurface onPress={onRetry} accessibilityRole="button">
                <Text>{t('mobile.logbook.boardRetry')}</Text>
              </PressableSurface>
            ) : !isPending && choices.length === 1 ? (
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
