import { useCallback, useMemo } from 'react';
import { router } from 'expo-router';
import type { UserBoard } from '@boardsesh/shared-schema';
import { OnboardingBoardStep } from './OnboardingBoardStep';
import { useMyBoards, useProfile } from '../../lib/graphql/hooks';
import { useAuth } from '../../providers/auth-provider';
import { useIsOffline } from '../../hooks/use-is-offline';
import { useStoredUserId } from '../../hooks/use-current-user-id';
import { useActivateBoard } from '../../lib/boards/use-activate-board';
import { useOfflineDownloadsEnabled } from '../../providers/feature-flags-provider';
import { useConfirmBoardDownload } from '../../offline/use-confirm-board-download';
import { useDownloadedScopeKeys } from '../../offline/use-downloaded-scope-keys';
import { useBoardOfflineState } from '../board-discovery/use-board-offline-state';
import { trackNudgeAccepted, trackNudgeDismissed, trackNudgeShown } from '../../lib/offline-nudges/nudge-analytics';
import type { NudgeEventContext } from '../../lib/offline-nudges/nudge-analytics';
import { offlineBoardKeyForBoard } from '../../settings';

// Module-level so an absent board list keeps a stable identity — a fresh `[]`
// per render would rebuild the carousel's items on every commit.
const EMPTY_BOARDS: UserBoard[] = [];

/**
 * The board step's data and exits.
 *
 * Its own component, like `BoardLookRoute`, so the queries behind it (the board
 * list, the downloaded-scope index) mount only while this step is the one on
 * screen — the framing card must not pay for them.
 */
export function OnboardingBoardRoute({
  accentColor,
  bodyColor,
  backgroundColor,
}: {
  accentColor: string;
  bodyColor: string;
  backgroundColor: string;
}) {
  const { isAuthenticated } = useAuth();
  // Who is looking, so viewer-owned boards lead the row. Same degraded-never-
  // blocked read as `/boards`: the stored id answers with no network, and a
  // missing id only costs the ordering, never the ability to pick.
  const { data: profile } = useProfile({ enabled: isAuthenticated });
  const { userId: storedUserId } = useStoredUserId(isAuthenticated && !profile?.id);
  const currentUserId = profile?.id ?? storedUserId;

  const { data: boardConnection, isLoading, isError } = useMyBoards(undefined, { enabled: isAuthenticated });
  const boards = boardConnection?.boards ?? EMPTY_BOARDS;

  const isOffline = useIsOffline();
  const offlineDownloadsEnabled = useOfflineDownloadsEnabled();
  const { confirmAndDownload } = useConfirmBoardDownload();
  const { data: downloadedScopeKeys } = useDownloadedScopeKeys();
  const boardOfflineState = useBoardOfflineState();

  const nudgeContextFor = useCallback(
    (board: UserBoard, surface: NudgeEventContext['surface']): NudgeEventContext => ({
      surface,
      boardType: board.boardType,
      layoutId: board.layoutId,
      scopeKey: offlineBoardKeyForBoard(board),
      downloadedBoardCount: (downloadedScopeKeys ?? []).length,
    }),
    [downloadedScopeKeys],
  );

  /**
   * The download offer, run after the board is bound and before we leave.
   *
   * Only for a scope that isn't already on the phone or on its way — a dialog
   * quoting a download the climber has already asked for is noise. Offline it is
   * skipped entirely rather than armed silently: this is a first-run screen, and
   * arming something invisible that lands "sometime after you reconnect" is not
   * a promise worth making without asking.
   *
   * `confirmAndDownload` quotes the real artifact size, so the Cancel here is the
   * informed "not now" — the download stays skippable, unlike the board itself.
   */
  const offerDownload = useCallback(
    async (board: UserBoard) => {
      if (!offlineDownloadsEnabled || isOffline) return;
      if (boardOfflineState(board) !== 'off') return;

      const context = nudgeContextFor(board, 'onboarding');
      trackNudgeShown(context);
      const confirmed = await confirmAndDownload(board, { trigger: 'onboarding', source: 'onboarding' });
      if (confirmed) trackNudgeAccepted(context, 'download');
      else trackNudgeDismissed(context, 'once');
    },
    [offlineDownloadsEnabled, isOffline, boardOfflineState, nudgeContextFor, confirmAndDownload],
  );

  // `replace`, not the picker's `dismissTo`: onboarding is a full-screen cover
  // with nothing of its own left to return to, and the board-look gate picks the
  // climber up on Climbs.
  const leaveToClimbs = useCallback(() => {
    router.replace('/(tabs)/climbs');
  }, []);

  const activateBoard = useActivateBoard({
    source: 'onboarding',
    returnTo: '/(tabs)/climbs',
    navigate: leaveToClimbs,
    onBound: offerDownload,
  });

  const onSelect = useCallback((board: UserBoard) => void activateBoard(board), [activateBoard]);

  /**
   * The card glyph: download a board WITHOUT binding it.
   *
   * Deliberately reported as `board_card`, not `onboarding` — it is the same
   * glyph, on the same card, doing the same thing as the one on `/boards`, and
   * it is accept-only there because a card scrolling past in a carousel is not a
   * suggestion the way a dialog is. Filing it under `onboarding` would mix an
   * impression-tracked offer with an untracked one and quietly wreck that
   * surface's shown-to-accepted rate.
   */
  const onDownload = useCallback(
    (board: UserBoard) => {
      void confirmAndDownload(board, { trigger: 'onboarding', source: 'onboarding' }).then((confirmed) => {
        if (confirmed) trackNudgeAccepted(nudgeContextFor(board, 'board_card'), 'download');
      });
    },
    [confirmAndDownload, nudgeContextFor],
  );

  const onFindBoard = useCallback(() => {
    // `source=onboarding` drives the picker's framing header, its location
    // pre-resolve, and — through `useActivateBoard` — the activation event and
    // the one-time Climbs reveal banner, whether they pick a board there or
    // build one in `/boards/create`.
    router.push({ pathname: '/boards', params: { source: 'onboarding' } });
  }, []);

  /**
   * The single escape hatch, and the conditions are narrow on purpose: no usable
   * connection AND nothing to show. `/boards` cannot help either — its offline
   * branch lists boards this device has downloaded, and a fresh install has
   * none — so this is a screen that genuinely cannot resolve.
   *
   * It does not mark onboarding complete. The gate is "has a board", so the
   * climber is asked again on the next launch, when the network may be back.
   *
   * `isError` is in here alongside `isOffline` for the lying-connection case:
   * captive-portal or gym wifi with a dead upstream reports ONLINE while every
   * request fails, so `isOffline` alone would leave that climber stuck.
   */
  const canOfferNothing = (isOffline || isError) && boards.length === 0 && !isLoading;
  const onSkipUnusable = useMemo(() => (canOfferNothing ? leaveToClimbs : null), [canOfferNothing, leaveToClimbs]);

  return (
    <OnboardingBoardStep
      accentColor={accentColor}
      bodyColor={bodyColor}
      backgroundColor={backgroundColor}
      boards={boards}
      isLoading={isLoading}
      offlineDownloadsEnabled={offlineDownloadsEnabled}
      currentUserId={currentUserId}
      onSkipUnusable={onSkipUnusable}
      onSelect={onSelect}
      onDownload={onDownload}
      onFindBoard={onFindBoard}
    />
  );
}
