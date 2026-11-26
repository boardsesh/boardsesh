// The add-a-board wizard's "Whose board?" (flag `add-board-wizard`): home
// boards owned by the climber's friends (`friendsBoards`: they follow each
// other), grouped under their owner. Step 2 of 2 from "Where's the board?"; the picker's Friends'
// boards shelf opens it too ("See all", uncounted). A tap climbs the board, or
// asks its owner first (use-friend-board-action.tsx).
//
// One virtualized FlashList: an owner header cell, then each of their boards
// as a slice of an inset-grouped card. The step header and the search sit in
// the list header; Find people, Share your profile and the share-link hint in
// its footer. One page per end-reach.
//
// A board shows up here only once the climber and its owner follow each other,
// so either side may be missing a follow: Find people is for the climber to
// follow their friend, Share your profile for the friend to follow them.
//
// "Scan a board code" under the search opens the in-app camera
// (boards/add/scan.tsx). It is hidden on a binary without the camera module
// and in the browser app (camera-module.ts).

import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { FlashList } from '@shopify/flash-list';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import type { FriendBoard } from '@boardsesh/shared-schema';
import { ActivityIndicator } from '../../../src/components/ActivityIndicator';
import { Avatar } from '../../../src/components/Avatar';
import { Button } from '../../../src/components/Button';
import { EmptyState } from '../../../src/components/EmptyState';
import { SearchField } from '../../../src/components/SearchField';
import { SHELF_SECTION_GAP } from '../../../src/components/ShelfHeader';
import { Text } from '../../../src/components/Text';
import { BoardRow } from '../../../src/components/board-discovery/BoardRow';
import type { DiscoveryBoardItem } from '../../../src/components/board-discovery/BoardDiscoveryCardView';
import { DiscoveryBoardArt } from '../../../src/components/board-discovery/DiscoveryBoardArt';
import { WizardStepHeader } from '../../../src/components/board-discovery/add-board-wizard/WizardStepHeader';
import { InsetGroupedCell } from '../../../src/components/gym-page/InsetGroupedCell';
import type { GroupedCellPosition } from '../../../src/components/gym-page/gym-page-view-model';
import { useBottomChromeMetrics } from '../../../src/hooks/use-bottom-chrome-metrics';
import { useStoredUserId } from '../../../src/hooks/use-current-user-id';
import { useOfflineQueryState } from '../../../src/hooks/use-offline-query-state';
import { isBoardCodeScannerAvailable } from '../../../src/lib/board-code-scanner/camera-module';
import { useProfileShareOptions } from '../../../src/hooks/use-profile-share-options';
import { useShareLinkAction } from '../../../src/hooks/use-share-link-action';
import { noteBoardFlowSecured } from '../../../src/lib/boards/board-create-flow';
import { resolveBoardReturnTo } from '../../../src/lib/boards/board-return-to';
import {
  friendBoardListCells,
  friendBoardsEmptyKind,
  type FriendBoardListCell,
  type FriendBoardRowCopy,
} from '../../../src/lib/boards/friend-boards';
import { useAddBoardWizardStep } from '../../../src/lib/boards/use-add-board-wizard-step';
import { useFriendBoardAction } from '../../../src/lib/boards/use-friend-board-action';
import { useProfile } from '../../../src/lib/graphql/hooks';
import { useFriendsBoards } from '../../../src/lib/graphql/hooks/use-friends-boards';
import { usePrivacySettings } from '../../../src/lib/graphql/hooks/use-privacy';
import { useActiveBoard } from '../../../src/lib/graphql/use-active-board';
import { openSignIn } from '../../../src/lib/routing/open-sign-in';
import { useAuth } from '../../../src/providers/auth-provider';
import { useTheme } from '../../../src/providers/theme-provider';
import { spacing } from '../../../src/theme/tokens';

const SEARCH_DEBOUNCE_MS = 300;
const OWNER_AVATAR_SIZE = 28;
const EMPTY_FRIEND_BOARDS: FriendBoard[] = [];

const keyExtractor = (cell: FriendBoardListCell) => cell.key;
const getItemType = (cell: FriendBoardListCell) => cell.kind;

export default function AddBoardFriend() {
  const { t } = useTranslation('boards');
  const router = useRouter();
  const { systemColors } = useTheme();
  const bottomChrome = useBottomChromeMetrics();
  const params = useLocalSearchParams<{ shelf?: string }>();
  const fromShelf = params.shelf === '1';
  const { nextContext, stepLabel, markHandedOff } = useAddBoardWizardStep({
    step: 'friend',
    path: 'friend',
    abandonStep: 'find',
    abandonKind: null,
  });
  // "See all" from the picker is browsing, not a board flow to abandon.
  useEffect(() => {
    if (fromShelf) markHandedOff();
  }, [fromShelf, markHandedOff]);

  const { isAuthenticated } = useAuth();
  // The id keys the list; the profile read failing online must not leave it
  // disabled behind a spinner, so the id saved at sign-in stands in, as it
  // does in the picker.
  const { data: profile, isError: profileFailed, refetch: refetchProfile } = useProfile({ enabled: isAuthenticated });
  const { userId: storedUserId, isLoading: storedUserIdLoading } = useStoredUserId(isAuthenticated && !profile?.id);
  const viewerId = isAuthenticated ? (profile?.id ?? storedUserId) : undefined;
  // Neither source has an id: the list can't be asked for, so say so.
  const viewerUnknown = isAuthenticated && viewerId === undefined && profileFailed && !storedUserIdLoading;
  const { data: activeBoard } = useActiveBoard();

  const [searchText, setSearchText] = useState('');
  const trimmedSearch = searchText.trim();
  const [query, setQuery] = useState('');
  useEffect(() => {
    const handle = setTimeout(() => setQuery(trimmedSearch), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [trimmedSearch]);

  const friendsBoards = useFriendsBoards({ viewerId, query, enabled: isAuthenticated });
  const { data, hasNextPage, isFetchingNextPage, fetchNextPage, isPending, isError, refetch, fetchStatus } =
    friendsBoards;
  const offline = useOfflineQueryState(friendsBoards);

  const copy = useMemo<FriendBoardRowCopy>(
    () => ({ ownerFallback: t('mobile.friendBoards.ownerFallback'), requested: t('mobile.friendBoards.requested') }),
    [t],
  );
  const friendBoards = useMemo(() => data?.pages.flatMap((page) => page.items) ?? EMPTY_FRIEND_BOARDS, [data]);
  const cells = useMemo(
    () => friendBoardListCells(friendBoards, { copy, activeUuid: activeBoard?.uuid }),
    [friendBoards, copy, activeBoard?.uuid],
  );

  const beforeClimb = useCallback(() => {
    noteBoardFlowSecured();
  }, []);
  const { onPress, sheet } = useFriendBoardAction({
    returnTo: resolveBoardReturnTo(nextContext.returnTo),
    section: 'friend_step',
    beforeClimb,
  });
  // A row's place among the boards as drawn, for the pick event.
  const positions = useMemo(() => {
    const byKey = new Map<string, number>();
    let index = 0;
    for (const cell of cells) if (cell.kind === 'board') byKey.set(cell.item.key, index++);
    return byKey;
  }, [cells]);
  const friendBoardsByKey = useMemo(
    () => new Map(friendBoards.map((friendBoard) => [friendBoard.preview.uuid, friendBoard])),
    [friendBoards],
  );
  const onSelect = useCallback(
    (item: DiscoveryBoardItem) => {
      const friendBoard = friendBoardsByKey.get(item.key);
      if (friendBoard) onPress(friendBoard, positions.get(item.key) ?? 0);
    },
    [friendBoardsByKey, onPress, positions],
  );

  const onEndReached = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage && fetchStatus === 'idle') void fetchNextPage({ cancelRefetch: false });
  }, [hasNextPage, isFetchingNextPage, fetchStatus, fetchNextPage]);
  const retry = useCallback(() => {
    if (viewerUnknown) void refetchProfile();
    else void refetch();
  }, [viewerUnknown, refetchProfile, refetch]);
  // Pull to refresh: the spinner follows the pull, not background refetches.
  const [pullRefreshing, setPullRefreshing] = useState(false);
  const onRefresh = useCallback(() => {
    setPullRefreshing(true);
    void refetch().finally(() => setPullRefreshing(false));
  }, [refetch]);
  // The climber follows their friend from the climber search inside this
  // modal's stack, and sends their profile link so the friend can follow them.
  // Only a public profile has a link (useProfileShareOptions); a private one
  // shows no share button.
  const findPeople = useCallback(() => router.push('/boards/users/search'), [router]);
  const { data: privacy } = usePrivacySettings();
  const profileShare = useProfileShareOptions({
    userId: profile?.id,
    displayName: profile?.displayName,
    isPrivate: privacy?.isPrivate,
  });
  const shareProfile = useShareLinkAction(profileShare);
  const canShareProfile = profileShare.url !== null;
  const signIn = useCallback(() => openSignIn(router, 'boards'), [router]);
  // Asked once per app run: the binary either links the camera module or not.
  const [canScan] = useState(isBoardCodeScannerAvailable);
  const scanCode = useCallback(() => router.push('/boards/add/scan'), [router]);

  const renderItem = useCallback(
    ({ item: cell }: { item: FriendBoardListCell }) =>
      cell.kind === 'owner' ? (
        <OwnerHeaderCell name={cell.name} avatarUrl={cell.owner.avatarUrl} />
      ) : (
        <FriendBoardCell item={cell.item} position={cell.position} onSelect={onSelect} />
      ),
    [onSelect],
  );

  if (!isAuthenticated) {
    return (
      <View style={styles.flex}>
        <View style={styles.header}>
          <WizardStepHeader stepLabel={stepLabel} title={t('mobile.friendBoards.stepTitle')} />
        </View>
        <EmptyState
          size="section"
          title={t('mobile.friendBoards.signInTitle')}
          actions={<Button title={t('mobile.friendBoards.signIn')} onPress={signIn} />}
          testID="friend-boards-sign-in"
        />
      </View>
    );
  }

  const emptyKind = friendBoardsEmptyKind({
    offline: offline.isBlocked,
    query,
    boardCount: cells.length,
  });
  const searching = trimmedSearch !== query;
  const showSpinner = cells.length === 0 && !viewerUnknown && (searching || (isPending && !offline.isBlocked));

  const listEmpty = showSpinner ? (
    <View style={styles.centerState}>
      <ActivityIndicator size="small" />
    </View>
  ) : (isError || viewerUnknown) && emptyKind !== 'offline' ? (
    <EmptyState
      size="section"
      title={t('mobile.friendBoards.loadFailed')}
      actions={<Button title={t('mobile.findWall.retry')} variant="outlined" onPress={retry} />}
      testID="friend-boards-failed"
    />
  ) : emptyKind === 'offline' ? (
    <EmptyState
      size="section"
      title={t('mobile.friendBoards.offline')}
      actions={<Button title={t('mobile.findWall.retry')} variant="outlined" onPress={retry} />}
      testID="friend-boards-offline"
    />
  ) : emptyKind === 'no_match' ? (
    <EmptyState size="section" title={t('mobile.friendBoards.noMatch', { query })} testID="friend-boards-no-match" />
  ) : (
    <EmptyState
      size="section"
      title={t('mobile.friendBoards.noBoardsTitle')}
      body={t('mobile.friendBoards.noBoardsBody')}
      actions={
        <>
          <Button title={t('mobile.friendBoards.findPeople')} onPress={findPeople} testID="friend-boards-find-people" />
          {canShareProfile ? (
            <Button
              title={t('mobile.friendBoards.shareProfile')}
              variant="text"
              onPress={shareProfile}
              testID="friend-boards-share-profile"
            />
          ) : null}
        </>
      }
      testID="friend-boards-no-boards"
    />
  );
  // The empty placard carries both actions itself.
  const footerActions = emptyKind !== 'no_boards';

  const listHeader = (
    <View>
      <View style={styles.header}>
        <WizardStepHeader stepLabel={stepLabel} title={t('mobile.friendBoards.stepTitle')} />
      </View>
      <View style={styles.search}>
        <SearchField
          value={searchText}
          onChangeText={setSearchText}
          placeholder={t('mobile.friendBoards.searchPlaceholder')}
          clearAccessibilityLabel={t('mobile.friendBoards.clearSearch')}
        />
      </View>
      {canScan ? (
        <View style={styles.scan}>
          <Button
            title={t('mobile.scanCode.button')}
            icon="camera"
            variant="tonal"
            onPress={scanCode}
            testID="friend-boards-scan-code"
          />
        </View>
      ) : null}
    </View>
  );

  const listFooter = (
    <View style={styles.footer}>
      {isFetchingNextPage ? <ActivityIndicator size="small" /> : null}
      {footerActions ? (
        <Button
          title={t('mobile.friendBoards.notFollowing')}
          variant="text"
          onPress={findPeople}
          testID="friend-boards-find-people-footer"
        />
      ) : null}
      {footerActions && canShareProfile ? (
        <Button
          title={t('mobile.friendBoards.shareProfileFooter')}
          variant="text"
          onPress={shareProfile}
          testID="friend-boards-share-profile-footer"
        />
      ) : null}
      <Text variant="footnote" color={systemColors.secondaryLabel} style={styles.hint}>
        {t('mobile.friendBoards.linkHint')}
      </Text>
    </View>
  );

  return (
    <>
      <FlashList
        data={cells}
        renderItem={renderItem}
        keyExtractor={keyExtractor}
        getItemType={getItemType}
        ListHeaderComponent={listHeader}
        ListEmptyComponent={listEmpty}
        ListFooterComponent={listFooter}
        onEndReached={onEndReached}
        onEndReachedThreshold={0.5}
        refreshing={pullRefreshing}
        onRefresh={viewerId === undefined ? undefined : onRefresh}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{ paddingTop: spacing[3], paddingBottom: bottomChrome.scrollBottomPadding }}
        testID="friend-boards"
      />
      {sheet}
    </>
  );
}

/** An owner's name over their boards, with their avatar. */
const OwnerHeaderCell = memo(function OwnerHeaderCell({ name, avatarUrl }: { name: string; avatarUrl: string | null }) {
  return (
    <View style={styles.ownerHeader} accessibilityRole="header">
      <Avatar uri={avatarUrl} name={name} size={OWNER_AVATAR_SIZE} />
      <Text variant="headline" numberOfLines={1} style={styles.ownerName}>
        {name}
      </Text>
    </View>
  );
});

/** One friend's board: a `BoardRow` as its own slice of the owner's card. */
const FriendBoardCell = memo(function FriendBoardCell({
  item,
  position,
  onSelect,
}: {
  item: DiscoveryBoardItem;
  position: GroupedCellPosition;
  onSelect: (item: DiscoveryBoardItem) => void;
}) {
  return (
    <InsetGroupedCell position={position} separatorInset="regular" endGap={SHELF_SECTION_GAP}>
      <BoardRow item={item} onPress={onSelect} BoardArt={DiscoveryBoardArt} />
    </InsetGroupedCell>
  );
});

const styles = StyleSheet.create({
  flex: {
    flex: 1,
    paddingTop: spacing[4],
  },
  header: {
    paddingBottom: spacing[4],
  },
  search: {
    paddingHorizontal: spacing[4],
    paddingBottom: spacing[4],
  },
  scan: {
    alignItems: 'flex-start',
    paddingHorizontal: spacing[4],
    paddingBottom: spacing[4],
  },
  ownerHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[2],
    paddingHorizontal: spacing[4],
    paddingBottom: spacing[2],
  },
  ownerName: {
    flexShrink: 1,
  },
  centerState: {
    alignItems: 'center',
    paddingVertical: spacing[8],
  },
  footer: {
    alignItems: 'center',
    gap: spacing[2],
    paddingHorizontal: spacing[4],
    paddingTop: spacing[2],
  },
  hint: {
    textAlign: 'center',
  },
});
