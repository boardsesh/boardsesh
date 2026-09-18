import { useCallback, useMemo } from 'react';
import { View, StyleSheet } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { PlaylistDetailView, PlaylistQueueReplaceSheet, PlaylistBackFab } from '../../../../src/components/playlist';
import { SetterFollowButton } from '../../../../src/components/SetterFollowButton';
import { Button } from '../../../../src/components/Button';
import { Text } from '../../../../src/components/Text';
import {
  usePlaylistActivation,
  type UsePlaylistActivationOptions,
} from '../../../../src/lib/playlists/use-playlist-activation';
import { usePlaylistRenderBoard } from '../../../../src/lib/playlists/use-playlist-render-board';
import { setterPlaylistInput } from '../../../../src/lib/playlists/setter-playlist-input';
import { useInfiniteSearchClimbs } from '../../../../src/lib/graphql/hooks/use-infinite-search-climbs';
import { useSearchClimbsCount } from '../../../../src/lib/graphql/hooks';
import { SEARCH_CLIMBS, type SearchClimbsQueryResponse } from '../../../../src/lib/graphql/operations';
import { offlineAwareRequest } from '../../../../src/lib/graphql/offline-request';
import { toQueueClimbs } from '../../../../src/lib/climb-types';
import { useIsSharedSession } from '../../../../src/providers/queue-provider';
import { createAbortError } from '../../../../src/lib/graphql/request-timeout';
import { spacing } from '../../../../src/theme/tokens';
import { setterPlaylistReturnTo } from '../../../../src/lib/boards/board-return-to';

// Hooks still need an input while no board is selected; both queries stay disabled.
const PLACEHOLDER_BOARD = { boardName: '', layoutId: 0, sizeId: 0, setIds: '', angle: 0 };

export default function SetterPlaylist() {
  // `boardType`/`layoutId` are optional and name the board the CALLER was
  // looking at. Without them this resolves against the viewer's active board,
  // so arriving from a card for a setter on someone else's wall would filter
  // their climbs to a board they never set on — an empty list, with the climbs
  // the caller was trying to reach nowhere in it.
  const { username, boardType, layoutId } = useLocalSearchParams<{
    username: string;
    boardType?: string;
    layoutId?: string;
  }>();
  const { t } = useTranslation('climbs');
  const router = useRouter();
  const sourceBoard = useMemo(
    () => (boardType ? { boardType, layoutId: layoutId ? Number(layoutId) : null } : null),
    [boardType, layoutId],
  );
  const { renderBoard } = usePlaylistRenderBoard(sourceBoard);
  const input = useMemo(() => setterPlaylistInput(username, renderBoard ?? PLACEHOLDER_BOARD), [username, renderBoard]);
  const query = useInfiniteSearchClimbs(input, !!renderBoard && !!username);
  const count = useSearchClimbsCount(input, !!renderBoard && !!username);
  const allClimbs = useMemo(() => toQueueClimbs(query.data?.pages.flatMap((page) => page.climbs) ?? []), [query.data]);
  const fetchPage = useCallback<UsePlaylistActivationOptions['fetchPage']>(
    async ({ page, pageSize, board, signal }) => {
      if (signal.aborted) throw createAbortError('Setter playlist navigation was cancelled');
      const response = await offlineAwareRequest<SearchClimbsQueryResponse>(SEARCH_CLIMBS, {
        input: { ...setterPlaylistInput(username, board), page, pageSize },
      });
      if (signal.aborted) throw createAbortError('Setter playlist navigation was cancelled');
      return { climbs: toQueueClimbs(response.searchClimbs.climbs), hasMore: response.searchClimbs.hasMore };
    },
    [username],
  );
  const isSharedSession = useIsSharedSession();
  const activation = usePlaylistActivation({
    sourceId: `setter:${username}:${JSON.stringify(renderBoard)}`,
    allClimbs,
    fetchPage,
    previewOnly: isSharedSession,
    replaceQueueOnActivate: true,
    refreshErrorMessage: 'Failed to refresh setter playlist',
  });
  const hero = useMemo(
    () => ({ name: username, climbCount: count.data ?? allClimbs.length, subtitle: t('authors.playlistSubtitle') }),
    [username, count.data, allClimbs.length, t],
  );
  const actions = useCallback(() => <SetterFollowButton username={username} />, [username]);
  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      {renderBoard ? (
        <PlaylistDetailView
          hero={hero}
          actions={actions}
          climbs={allClimbs}
          renderBoard={renderBoard}
          isLoading={query.isLoading}
          isFetchingNextPage={query.isFetchingNextPage}
          hasNextPage={query.hasNextPage ?? false}
          fetchNextPage={query.fetchNextPage}
          onActivateClimb={activation.activate}
          emptyMessage={query.isError ? t('authors.loadError') : t('authors.empty')}
          headerSlot={
            query.isError ? <Button title={t('authors.retry')} onPress={() => void query.refetch()} /> : undefined
          }
        />
      ) : (
        <View style={styles.chooseBoard}>
          <PlaylistBackFab />
          <Text>{t('authors.chooseBoard')}</Text>
          <Button
            title={t('authors.chooseBoard')}
            onPress={() =>
              router.push({
                pathname: '/boards',
                params: { returnTo: setterPlaylistReturnTo(username) },
              })
            }
          />
        </View>
      )}
      <PlaylistQueueReplaceSheet {...activation.queueReplaceSheet} />
    </>
  );
}

const styles = StyleSheet.create({
  chooseBoard: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing[4], gap: spacing[3] },
});
