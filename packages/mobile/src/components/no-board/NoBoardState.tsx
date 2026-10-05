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
import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { SHARED_EVENTS } from '@boardsesh/analytics';
import { Text } from '../Text';
import { Icon } from '../Icon';
import { Button } from '../Button';
import { NoBoardClimbsPreview, type NoBoardPreviewSearchOutcome } from './NoBoardClimbsPreview';
import { useAuth } from '../../providers/auth-provider';
import { useFeatureFlagsResolved, useNoBoardPreviewEnabled } from '../../providers/feature-flags-provider';
import { useIsOffline } from '../../hooks/use-is-offline';
import { useMyBoards, usePopularBoardConfigs, useProfile } from '../../lib/graphql/hooks';
import { track } from '../../lib/analytics';
import { nowMs } from '../../lib/clock';
import { accountAgeHours } from '../../lib/onboarding/onboarding-gate-analytics';
import { noBoardPickerHref } from '../../lib/boards/first-board-mode';
import {
  decideNoBoardState,
  resolvePreviewConfigs,
  type NoBoardDecision,
  type NoBoardPreviewConfig,
  type NoBoardQueryStatus,
} from '../../lib/boards/no-board-preview';
import { iosSystemColors } from '../../theme/ios-colors';
import { spacing } from '../../theme/tokens';

// The picker and the board builder read the popular list with this same input,
// so all three share one cache entry.
const POPULAR_CONFIGS_INPUT = { limit: 12 };

type SettledNoBoardDecision = Exclude<NoBoardDecision, { status: 'pending' }>;

function queryStatus(hasData: boolean, isError: boolean): NoBoardQueryStatus {
  if (hasData) return 'ready';
  return isError ? 'error' : 'pending';
}

export function NoBoardState() {
  const router = useRouter();
  const { t } = useTranslation('climbs');
  const { isAuthenticated, isLoading: isAuthLoading } = useAuth();
  const isOffline = useIsOffline();
  const flagsResolved = useFeatureFlagsResolved();
  const previewEnabled = useNoBoardPreviewEnabled();

  // The roster the drawer host keeps warm (same key), so this is usually a
  // cache read.
  const { data: boardConnection, isError: isBoardsError } = useMyBoards(undefined, { enabled: isAuthenticated });
  const boardsStatus = queryStatus(boardConnection !== undefined, isBoardsError);
  const ownedBoardCount = boardConnection?.boards.length ?? 0;

  const { data: profile, isPending: isProfilePending } = useProfile({ enabled: isAuthenticated });
  const accountCreatedAt = profile?.createdAt;

  // Only asked for once the preview is still possible: a climber with boards of
  // their own never pays for it here.
  const previewPossible = isAuthenticated && previewEnabled && boardsStatus === 'ready' && ownedBoardCount === 0;
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
    profileSettled: !isProfilePending,
    popularStatus: queryStatus(popularConnection !== undefined, isPopularError),
    previewConfigs,
  });

  // The first settled answer is held for as long as this state is on screen. A
  // refetch or a connectivity blip behind it must not swap a list the climber
  // is reading for a placard, or the other way round. Set during render, so the
  // frame that settles already shows the right branch.
  const [held, setHeld] = useState<SettledNoBoardDecision | null>(null);
  if (held === null && decision.status !== 'pending') setHeld(decision);

  // The preview has shown climbs. Until then it is a spinner, and a search that
  // fails, comes back empty, or cannot start hands the screen back to the placard.
  const [previewReady, setPreviewReady] = useState(false);
  if (held?.status === 'preview' && !previewReady && isOffline) {
    setHeld({ status: 'placard', fallbackReason: 'offline', ownedBoardCount: held.ownedBoardCount });
  }

  const handleSearchSettled = useCallback((outcome: NoBoardPreviewSearchOutcome) => {
    if (outcome === 'ready') {
      setPreviewReady(true);
      return;
    }
    setHeld({
      status: 'placard',
      fallbackReason: outcome === 'error' ? 'search_error' : 'no_climbs',
      ownedBoardCount: 0,
    });
  }, []);

  // Exposure, once per mount, for what the climber actually got: a placard as
  // soon as it is decided, a preview once its climbs are on screen.
  const viewedRef = useRef(false);
  useEffect(() => {
    if (viewedRef.current || held === null) return;
    if (held.status === 'preview' && !previewReady) return;
    viewedRef.current = true;
    track(SHARED_EVENTS.ClimbsNoBoardStateViewed, {
      variant: held.status,
      owned_board_count: held.ownedBoardCount,
      account_age_hours: accountAgeHours(accountCreatedAt, nowMs()),
      preview_board_type: held.status === 'preview' ? held.configs[0].boardName : null,
      fallback_reason: held.status === 'placard' ? held.fallbackReason : null,
    });
  }, [held, previewReady, accountCreatedAt]);

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

  if (held?.status === 'preview') {
    return (
      <NoBoardClimbsPreview
        configs={held.configs}
        onFindBoard={handleFindBoard}
        onClimbPress={handlePreviewClimbPress}
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
