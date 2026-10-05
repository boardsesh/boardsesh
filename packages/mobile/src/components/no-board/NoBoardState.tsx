// What Climbs shows when no board is bound: the "Pick your board" placard, or,
// for an account with no boards at all, a read-only preview of real climbs.
//
// A child of the Climbs screen on purpose. That screen returns early for this
// state, so every hook the choice needs has to live below the return: a hook
// added to the screen itself changes its hook count the moment a board binds
// (BOARDSESH-K1 / BOARDSESH-K2).
//
// Nothing here binds a board. The preview only names a setup to search.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useIsFocused, useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { SHARED_EVENTS } from '@boardsesh/analytics';
import { Text } from '../Text';
import { Icon } from '../Icon';
import { Button } from '../Button';
import { NoBoardClimbsPreview, type NoBoardPreviewSearchOutcome } from './NoBoardClimbsPreview';
import { useAuth } from '../../providers/auth-provider';
import { useFeatureFlagsResolved, useNoBoardPreviewEnabled } from '../../providers/feature-flags-provider';
import { useOptionalClimbSearch } from '../../providers/climb-search-provider';
import { useIsOffline } from '../../hooks/use-is-offline';
import { useMyBoards, usePopularBoardConfigs, useProfile } from '../../lib/graphql/hooks';
import { track } from '../../lib/analytics';
import { nowMs } from '../../lib/clock';
import { accountAgeHours } from '../../lib/account-age';
import { noBoardPickerHref } from '../../lib/boards/first-board-mode';
import {
  decideNoBoardState,
  holdsNoBoardDecision,
  isProfileSettled,
  resolvePreviewConfigs,
  type NoBoardPreviewConfig,
  type NoBoardQueryStatus,
  type SettledNoBoardDecision,
} from '../../lib/boards/no-board-preview';
import { iosSystemColors } from '../../theme/ios-colors';
import { spacing } from '../../theme/tokens';

// The picker and the board builder read the popular list with this same input,
// so all three share one cache entry.
const POPULAR_CONFIGS_INPUT = { limit: 12 };

/** Why a preview that was decided on never got its climbs on screen. */
type PreviewSearchFailure = 'search_error' | 'no_climbs';

function queryStatus(hasData: boolean, isError: boolean): NoBoardQueryStatus {
  if (hasData) return 'ready';
  return isError ? 'error' : 'pending';
}

export function NoBoardState() {
  const router = useRouter();
  const { t } = useTranslation('climbs');
  // Climbs is the app's entry tab, so this mounts underneath whatever is pushed
  // over it: the launch gate's first-board picker for a new account, most of
  // all. Nothing is searched and nothing is reported until the climber is
  // actually looking at it.
  const isFocused = useIsFocused();
  const { isAuthenticated, isLoading: isAuthLoading } = useAuth();
  const isOffline = useIsOffline();
  const flagsResolved = useFeatureFlagsResolved();
  const previewEnabled = useNoBoardPreviewEnabled();
  // What is typed in the Climbs search field, which stays up over this state.
  // The preview lists the climbs with that name; the placard has no use for it.
  // Optional, so this still mounts where there is no Climbs search at all.
  const searchName = useOptionalClimbSearch()?.name ?? '';

  // The roster the drawer host keeps warm (same key), so this is usually a
  // cache read.
  const { data: boardConnection, isError: isBoardsError } = useMyBoards(undefined, { enabled: isAuthenticated });
  const boardsStatus = queryStatus(boardConnection !== undefined, isBoardsError);
  const ownedBoardCount = boardConnection?.boards.length ?? 0;

  const {
    data: profile,
    isPending: isProfilePending,
    isFetching: isProfileFetching,
  } = useProfile({ enabled: isAuthenticated });
  const accountCreatedAt = profile?.createdAt;

  // Only asked for once the preview is still possible: a climber with boards of
  // their own never pays for it here, and neither does anyone while the kill
  // switch could still land (an unresolved flag bag reads as "enabled").
  const previewPossible =
    isAuthenticated && flagsResolved && previewEnabled && boardsStatus === 'ready' && ownedBoardCount === 0;
  const { data: popularConnection, isError: isPopularError } = usePopularBoardConfigs(POPULAR_CONFIGS_INPUT, {
    enabled: previewPossible,
  });
  const popularConfigs = popularConnection?.configs;
  const previewConfigs = useMemo(() => resolvePreviewConfigs(popularConfigs), [popularConfigs]);

  const decision = decideNoBoardState({
    authSettled: !isAuthLoading,
    isAuthenticated,
    isOffline,
    flagsResolved,
    previewEnabled,
    boardsStatus,
    ownedBoardCount,
    profileSettled: isProfileSettled({
      hasProfile: !!profile,
      isPending: isProfilePending,
      isFetching: isProfileFetching,
    }),
    popularStatus: queryStatus(popularConnection !== undefined, isPopularError),
    previewConfigs,
  });

  // An answer that later reads cannot make wrong is held for as long as this
  // state is mounted (see `holdsNoBoardDecision`): a refetch behind a list the
  // climber is reading must not swap it for a placard. A placard that only
  // describes this moment (offline, a failed read) is decided again on every
  // render, so the preview arrives once the connection does. Set during render,
  // so the frame that settles already shows the right branch.
  const [held, setHeld] = useState<SettledNoBoardDecision | null>(null);
  if (held === null && decision.status !== 'pending' && holdsNoBoardDecision(decision)) setHeld(decision);

  // The preview has shown climbs. From then on it stays: a later board type
  // whose search fails is the list's own problem to show, not a reason to take
  // the whole screen away.
  const [previewReady, setPreviewReady] = useState(false);
  // The first search failed or came back empty, so the placard is back.
  const [searchFailure, setSearchFailure] = useState<PreviewSearchFailure | null>(null);

  const handleSearchSettled = useCallback((outcome: NoBoardPreviewSearchOutcome) => {
    if (outcome === 'ready') {
      setPreviewReady(true);
      return;
    }
    setSearchFailure(outcome === 'error' ? 'search_error' : 'no_climbs');
  }, []);

  // A failed search gets another go each time the climber comes back to
  // Climbs. An empty one does not: the same setup would come back empty again.
  const wasFocusedRef = useRef(isFocused);
  useEffect(() => {
    if (isFocused && !wasFocusedRef.current) {
      setSearchFailure((failure) => (failure === 'search_error' ? null : failure));
    }
    wasFocusedRef.current = isFocused;
  }, [isFocused]);

  // What is on screen. Until a held preview has its first climbs it is only an
  // unlit wall and skeleton rows, so a lost connection or a failed search hands the screen back to
  // the placard. Offline is read live, so the preview returns with the signal.
  let shown: SettledNoBoardDecision | null = held ?? (decision.status === 'pending' ? null : decision);
  if (held?.status === 'preview' && !previewReady) {
    const fallbackReason = isOffline ? 'offline' : searchFailure;
    if (fallbackReason) shown = { status: 'placard', fallbackReason, ownedBoardCount: held.ownedBoardCount };
  }

  // Exposure, for what the climber actually got and only while they can see
  // it: a placard as soon as it is decided, a preview once its climbs are on
  // screen. Once per variant per mount, so a placard that a returning
  // connection turns into a preview reports both, in that order. A preview
  // never goes back to a placard once reported.
  const reportedVariantRef = useRef<SettledNoBoardDecision['status'] | null>(null);
  useEffect(() => {
    if (!isFocused || shown === null) return;
    if (shown.status === 'preview' && !previewReady) return;
    if (reportedVariantRef.current === shown.status) return;
    reportedVariantRef.current = shown.status;
    track(SHARED_EVENTS.ClimbsNoBoardStateViewed, {
      variant: shown.status,
      owned_board_count: shown.ownedBoardCount,
      account_age_hours: accountAgeHours(accountCreatedAt, nowMs()),
      preview_board_type: shown.status === 'preview' ? shown.configs[0].boardName : null,
      fallback_reason: shown.status === 'placard' ? shown.fallbackReason : null,
    });
  }, [isFocused, shown, previewReady, accountCreatedAt]);

  // The picker's no-board entry (#5654): a climber with no boards at all gets
  // "Where do you climb?" there, with the gym search, the builder and the
  // Bluetooth scan; one whose active board was only cleared gets their list.
  // Deliberately NOT tagged as onboarding: this state shows any time no board
  // is bound, not just first-run, so a bind from it must not fire the
  // activation event or arm the reveal banner.
  const handleFindBoard = useCallback(() => {
    router.push(noBoardPickerHref('cta'));
  }, [router]);

  // A tap on a previewed climb opens the picker, not the climb: opening one
  // needs a board to draw and light it on. The row's hint says so.
  const handlePreviewClimbPress = useCallback(
    (config: NoBoardPreviewConfig, rowIndex: number) => {
      track(SHARED_EVENTS.NoBoardPreviewClimbTapped, { board_type: config.boardName, row_index: rowIndex });
      router.push(noBoardPickerHref('preview_row'));
    },
    [router],
  );

  // The lit board at the top of the preview is the first climb of the page, so
  // it reports as place 0 of the same event and opens the same picker.
  const handlePreviewHeroPress = useCallback(
    (config: NoBoardPreviewConfig) => {
      track(SHARED_EVENTS.NoBoardPreviewClimbTapped, { board_type: config.boardName, row_index: 0 });
      router.push(noBoardPickerHref('preview_hero'));
    },
    [router],
  );

  if (shown?.status === 'preview') {
    return (
      <NoBoardClimbsPreview
        configs={shown.configs}
        active={isFocused}
        onFindBoard={handleFindBoard}
        onClimbPress={handlePreviewClimbPress}
        onHeroPress={handlePreviewHeroPress}
        searchName={searchName}
        onSearchSettled={handleSearchSettled}
      />
    );
  }

  return (
    <View testID="no-board-placard" style={styles.placard}>
      <Icon name="boards" size={48} color={iosSystemColors.systemGray4} />
      <Text variant="headline" style={styles.title}>
        {t('mobile.emptyState.noBoard.title')}
      </Text>
      <Text variant="subheadline" style={styles.subtitle}>
        {t('mobile.emptyState.noBoard.subtitle')}
      </Text>
      {/* Board selection is a modal. A bind there flips `useActiveBoard()`, and
          the Climbs screen swaps this state for the climb list by itself. */}
      <Button
        title={t('mobile.emptyState.noBoard.cta')}
        onPress={handleFindBoard}
        variant="filled"
        size="large"
        style={styles.cta}
      />
    </View>
  );
}

// The Climbs screen's own empty-state layout, so the placard sits exactly where
// it did before it moved here.
const styles = StyleSheet.create({
  placard: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingTop: 120,
    paddingHorizontal: 32,
    gap: 8,
  },
  title: {
    marginTop: 12,
    opacity: 0.6,
  },
  subtitle: {
    opacity: 0.4,
    textAlign: 'center',
  },
  cta: {
    marginTop: spacing[4],
  },
});
