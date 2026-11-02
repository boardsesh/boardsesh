// Runs the shared climb commands. The descriptors (ids, labels, icons, groups,
// visibility) come from `buildClimbMenuItems` (`climb-menu-items.ts`), the one
// source every native climb menu reads: the row long-press, the list and player
// ellipsis. This hook binds each descriptor to its command: it self-sources the
// queue / tick / beta video / report openers from `useDrawerHost`, the favourite
// state + mutation from `useFavoriteStatus` / `useToggleFavorite`, the native
// share from `useShareClimb`, and the create-climb routes from
// `useCreateClimbNavigation`. Menus offer no Preview: every list tap opens one.
import { useCallback, useEffect, useMemo } from 'react';
import type { OpaqueColorValue } from 'react-native';
import { useTranslation } from 'react-i18next';
import { randomUUID } from 'expo-crypto';
import { useQueryClient } from '@tanstack/react-query';
import { GET_FAVORITES, type FavoritesQueryResponse } from '@boardsesh/graphql/operations/favorites';
import { offlineAwareRequest } from '../../lib/graphql/offline-request';
import { getDatabaseHandle } from '../../db';
import { getPendingFavoriteOverridesLocal } from '../../db/queries/get-favorite-status-local';
import { getCredentialGeneration } from '../../lib/privacy/privacy-cache';
import { reportHandledError } from '../../lib/error-reporting';
import * as WebBrowser from 'expo-web-browser';
import type { Climb } from '@boardsesh/shared-schema';
import { SHARED_EVENTS, type AnalyticsEventProperties } from '@boardsesh/analytics';
import type { IconName } from '../icon-map';
import { useCreateClimbNavigation, type DismissSurfaceAndWait } from '../create-climb/use-create-climb-navigation';
import { useDrawerHost, boardConfigsMatch, type BoardConfig } from '../../providers/drawer-host-provider';
import {
  useActiveClimbUuid,
  useIsSharedSession,
  useQueueActions,
  useQueueSessionId,
} from '../../providers/queue-provider';
import { readQueuePickLanding } from '../play-drawer/queue-pick-landing';
import { resolveQueuedSlotUuid } from '../play-drawer/play-drawer-menu-rows';
import { useToggleFavorite, useFavoriteStatus } from '../../lib/graphql/hooks';
import { useTheme } from '../../providers/theme-provider';
import { useClimbModerationEnabled } from '../../providers/feature-flags-provider';
import { useShareClimb } from '../../hooks/use-share-climb';
import { track } from '../../lib/analytics';
import { useSprayWallIsArchived } from '../../lib/spray/use-spray-wall-archive';
import { useDeleteClimbAction } from './use-delete-climb-action';

import { resolveTickMirror } from '../../lib/queue-mirror-orientation';
import { buildClimbMenuItems, climbAuroraAppUrl } from './climb-menu-items';
import { useBluetoothConnectedStatus } from '../../lib/ble/bluetooth-status-store';

export type ClimbActionId =
  | 'queue'
  | 'openQueue'
  | 'playNext'
  | 'replayFromHere'
  | 'mirror'
  | 'angle'
  | 'playlist'
  | 'favorite'
  | 'tick'
  | 'editEntry'
  | 'betaVideo'
  | 'edit'
  | 'fork'
  | 'viewOptions'
  | 'share'
  | 'openInApp'
  | 'report'
  | 'delete';

export type ClimbActionItem = {
  id: ClimbActionId;
  /** Already-translated label. */
  title: string;
  /** App icon name — also the source of the iOS SF Symbol via `iconMap[icon].ios`. */
  icon: IconName;
  /** Resolved foreground colour (monochrome on Liquid Glass, semantic on Material).
   *  `string | OpaqueColorValue` because iOS system colours are PlatformColor. */
  color: string | OpaqueColorValue;
  /** Performs the action, then calls `onAfterAction`. */
  run: () => void;
};

/**
 * The surface the actions were opened from, reported as `source` on the events
 * this hook tracks. Omitted, each event keeps the long-press menu's historical
 * source (`climb_actions_menu`, `mobile_climb_actions`, `climb_actions`).
 */
export type ClimbActionsAnalyticsSource = 'play_drawer_menu' | 'mini_player_menu';

/**
 * A favourite the caller already owns. The player's heart keeps an optimistic
 * override over the server's answer; a menu row reading the server alone would
 * show the opposite state for the second after a tap, and a tap there would
 * leave the heart beside it stale.
 */
export type ClimbActionsFavoriteControl = {
  isFavorited: boolean;
  /** Runs instead of the hook's own mutation. The caller tracks the toggle. */
  onToggle: () => void;
};

/** The player's mirror toggle, for its ⋯ row while the bar's button is switched off. */
export type ClimbActionsMirrorControl = {
  isMirrored: boolean;
  /** The same toggle the bar's button runs, shared-session orientation included. */
  onToggle: () => void;
};

export type UseClimbActionsArgs = {
  climb: Climb | null;
  boardConfig: BoardConfig | null;
  /**
   * The exact queue slot this menu was opened for, when the source is a queue
   * row. Absent everywhere else (climb list, search, playlist, board sheet),
   * which only knows the climb — "Play next" then resolves the slot itself.
   */
  queueItemUuid?: string;
  /** Signed-in user id — gates the owner-only Edit action. */
  currentUserId?: string | null;
  /** Gates the "Add beta video" action. */
  isAuthenticated: boolean;
  /** When provided, adds an "Edit entry" action wired to the tick editor (logbook only). */
  onEditEntry?: () => void;
  /** Run after any action fires. The sheet passes its `onClose`; the native menu omits it. */
  onAfterAction?: () => void;
  /** Required sheet opener owned by the current surface, above any player route. */
  onSelectPlaylist: () => void;
  /**
   * When provided, the "Add beta video" action runs this INSTEAD of opening the
   * root `AddBetaVideoSheet`. The play drawer passes its own in-tree sheet opener
   * so the beta sheet stacks above the `/play` fullScreenModal (a root-tree sheet
   * can't present over it — see #3505). Receives the same `climb`/`boardConfig`
   * snapshot the fallback path uses, so a party-session queue/angle change while
   * the menu is open can't retarget it. Omit it and beta opens the root sheet.
   */
  onAddBetaVideo?: (climb: Climb, boardConfig: BoardConfig) => void;
  /**
   * In-tree opener for the "Tick" action. The play drawer passes its own opener
   * so the tick sheet stacks above the `/play` transparentModal. The root
   * `openLogAscent` sheet mounts BEHIND `/play`; presenting it forces UIKit to
   * dismiss `/play`, dragging the tick sheet down with it — the "tick sheet
   * closes immediately" bug. Same fix shape as `onAddBetaVideo` (#3505). Receives
   * the same `climb`/`boardConfig` snapshot the fallback path uses. Omit it and
   * ticking opens the root sheet (correct off `/play`, where nothing conflicts).
   */
  onTick?: (climb: Climb, boardConfig: BoardConfig) => void;
  /**
   * When provided, the "Report climb" action runs this INSTEAD of opening the
   * root `ReportClimbSheet`. The play drawer passes its own in-tree sheet opener
   * so the report sheet stacks above the `/play` modal (a root-tree sheet can't
   * present over it — see #3505). Receives the same `climb`/`boardConfig`
   * snapshot the fallback path uses, so a party-session queue/angle change while
   * the menu is open can't retarget it. Omit it and reporting opens the root sheet.
   */
  onReportClimb?: (climb: Climb, boardConfig: BoardConfig) => void;
  /**
   * When provided, adds "Open the queue", which runs this once the menu has
   * started closing. The play drawer passes its own queue opener while the
   * connect-step pill (#5654) has taken the queue button's place in its second
   * row; everywhere else the queue has its own button and this is omitted.
   */
  onOpenQueue?: () => void;
  /**
   * When provided, adds "View options", which runs this once the menu has
   * started closing. Only the play drawer passes it, with its own sections-sheet
   * opener, so the sheet presents above `/play`.
   */
  onOpenViewOptions?: () => void;
  /**
   * When provided, adds the player-only Mirror row. The play drawer passes it
   * while its bar has no mirror button showing; nothing else mirrors a climb.
   */
  mirrorControl?: ClimbActionsMirrorControl;
  /**
   * When provided, adds the player-only "Change angle" row, which runs this. The
   * play drawer passes its own angle-sheet opener while its bar has no angle pill
   * showing, so the sheet presents above `/play`.
   */
  onOpenAngle?: () => void;
  /** Native BoardSheet / QueueSheet underneath the custom overlay, if any. */
  dismissSourceSheet?: DismissSurfaceAndWait;
  /** `/play`-owned native-stack close waiter; absent for every inline surface. */
  dismissPlayerAndWait?: DismissSurfaceAndWait;
  /** See {@link ClimbActionsAnalyticsSource}. */
  analyticsSource?: ClimbActionsAnalyticsSource;
  analyticsContext?: AnalyticsEventProperties;
  /**
   * When provided, the favourite row reads and toggles the caller's state (see
   * {@link ClimbActionsFavoriteControl}), and the hook skips its own favourite read.
   */
  favoriteControl?: ClimbActionsFavoriteControl;
  /** Row-menu commands resolve exact favorite state only after selection. */
  resolveFavoriteOnAction?: boolean;
};

export function useClimbActions({
  climb,
  boardConfig,
  queueItemUuid,
  currentUserId,
  isAuthenticated,
  onEditEntry,
  onAfterAction,
  onSelectPlaylist,
  onAddBetaVideo,
  onTick,
  onReportClimb,
  onOpenQueue,
  onOpenViewOptions,
  mirrorControl,
  onOpenAngle,
  dismissSourceSheet,
  dismissPlayerAndWait,
  analyticsSource,
  analyticsContext,
  favoriteControl,
  resolveFavoriteOnAction = false,
}: UseClimbActionsArgs): ClimbActionItem[] {
  const { t } = useTranslation('climbs');
  const queryClient = useQueryClient();
  const inSharedSession = useIsSharedSession();
  const { openRemix, openEdit, resetActionGuard } = useCreateClimbNavigation({
    dismissSourceSheet,
    dismissPlayerAndWait,
  });
  // Edit and Remix claim one handoff at a time, and a handoff that throws keeps
  // its claim. The long-press menu mounts per open, so that never outlives it;
  // the player's ⋯ lives as long as the player, and would leave Edit and Remix
  // dead for the rest of the session. Let go whenever another climb is shown,
  // as the lost-hold banner does.
  const climbUuid = climb?.uuid;
  useEffect(() => {
    resetActionGuard();
  }, [climbUuid, resetActionGuard]);
  // An archived wall keeps its climbs readable, but the server refuses every
  // edit and new climb on it, so neither Edit nor Fork is offered there.
  const wallArchived = useSprayWallIsArchived(boardConfig?.boardName, boardConfig?.layoutId ?? null);
  const { actionColors } = useTheme();
  const { addToQueue, playNext, setCurrentClimb, findReplayFromHereItem, getQueueSnapshot } = useQueueActions();
  // The active session, so a tick logged from a climb-actions sheet lands on it.
  // Every other tick entry point (play drawer, queue bar, queue sheet) already
  // passes this; this one didn't, so ticking from the climbs list, board sheet,
  // logbook, a playlist — or the in-session screen's own climb rows — wrote
  // `session_id = NULL` mid-session and vanished from the session (#4975).
  // QueueProvider mounts at the app root (`app/_layout.tsx`) and `sessionId`
  // lives in its own split context, so reading it here costs no extra renders.
  const { sessionId } = useQueueSessionId();
  // Narrow selector context: its identity changes only when the climb on the
  // wall changes, so gating the Play next row on it costs the menu nothing.
  const activeClimbUuid = useActiveClimbUuid();
  const { mutate: toggleFavoriteMutate } = useToggleFavorite();
  // This phone's Bluetooth link, for `Favorite Toggle` only (#6002): a heart
  // added away from the wall is a "save for next session". One menu is mounted
  // at a time, so the subscription is a single listener.
  const bluetoothConnected = useBluetoothConnectedStatus();
  const {
    openPlayDrawer,
    openLogAscent,
    openAddBetaVideo,
    openReportClimb,
    boardConfig: activeBoardConfig,
  } = useDrawerHost();
  // Kill switch, so an unresolved flag still shows the row (see
  // useClimbModerationEnabled). Flipping it in PostHog takes reporting down
  // everywhere at once.
  const moderationEnabled = useClimbModerationEnabled();
  const requestDeleteClimb = useDeleteClimbAction();
  // Native share sheet — the same action the play drawer uses.
  const shareClimb = useShareClimb({
    climb,
    boardName: boardConfig?.boardName ?? '',
    layoutId: boardConfig?.layoutId ?? 0,
    sizeId: boardConfig?.sizeId ?? 0,
    setIds: boardConfig?.setIds ?? '',
    angle: boardConfig?.angle ?? 0,
  });
  // Server-truth favourite state, so the favorite row shows a filled heart when the
  // climb is already favourited. Only fetched while the menu is open (the hook is
  // mounted only then). useToggleFavorite invalidates this query, so it stays fresh.
  // A caller that owns the favourite (the player) answers it instead.
  const { data: serverFavorited } = useFavoriteStatus(
    boardConfig?.boardName ?? '',
    climb?.uuid ?? null,
    boardConfig?.angle ?? 0,
    {
      enabled: !!climb && !!boardConfig && !favoriteControl && !resolveFavoriteOnAction,
    },
  );
  const isFavorited = favoriteControl ? favoriteControl.isFavorited : serverFavorited;

  const after = useCallback(() => onAfterAction?.(), [onAfterAction]);

  return useMemo<ClimbActionItem[]>(() => {
    if (!climb || !boardConfig) return [];

    const { boardName, layoutId, sizeId, setIds, angle } = boardConfig;
    // Replay from here (F3, decision 8): a History row's long-press, while a
    // climb is on the wall and only in now-slot mode. It puts that climb back on
    // the wall with `placement: STEP`, so the climbs after it are Up next again
    // in their old order and nothing is copied. The plain row tap is unchanged:
    // it moves just that one climb into Now. Read at menu-build time; the
    // command host mounts per selection, so it can't go stale while open.
    const replayItem = queueItemUuid ? findReplayFromHereItem(queueItemUuid) : null;

    // Pass the state the row rendered from: it flips the heart in the climb
    // list optimistically, and it's what the offline local-first path needs to
    // know which way to write. The toggle tracks the tap, in the direction it
    // really goes (the heart's cache entry has the last word).
    const toggleKnownFavorite = (currentlyFavorited: boolean | undefined) =>
      toggleFavoriteMutate({
        input: { boardName, climbUuid: climb.uuid, angle },
        currentlyFavorited,
        tracking: { source: analyticsSource ?? 'mobile_climb_actions', layoutId, connected: bluetoothConnected },
      });
    // A row menu builds before its favourite is known (scrolling starts no
    // per-climb reads), so the toggle resolves the exact state after selection.
    const toggleResolvedFavorite = () => {
      const credentialScope = getCredentialGeneration();
      const queryKey = ['favoriteStatus', boardName, climb.uuid, angle];
      // Warm state includes optimistic/outbox intent and remains authoritative.
      const cachedFavoriteResponse = queryClient.getQueryData<FavoritesQueryResponse>(queryKey);
      // A cold entry may already have an unguarded network read in flight.
      // Replace that display read, without cancelling other menu actions'
      // shared lookup under the separate transient key below.
      if (cachedFavoriteResponse === undefined) {
        void queryClient.cancelQueries({ queryKey, exact: true });
      }
      const assertCurrentCredentials = () => {
        if (credentialScope !== getCredentialGeneration()) {
          throw new Error('Favorite resolution interrupted by account change');
        }
      };
      const favoriteResolution =
        cachedFavoriteResponse !== undefined
          ? Promise.resolve(cachedFavoriteResponse)
          : queryClient.fetchQuery({
              // Coalesce cold menu lookups without joining a display query or
              // matching useToggleFavorite's per-heart cancellation prefix.
              // The private prefix still clears this data on account changes.
              queryKey: ['favoriteStatus', 'menu-resolution', boardName, climb.uuid, angle, credentialScope],
              staleTime: 0,
              gcTime: 0,
              retry: false,
              queryFn: async () => {
                assertCurrentCredentials();
                let pendingFavorite: boolean | undefined;
                const db = getDatabaseHandle();
                if (db && currentUserId) {
                  try {
                    const pendingOverrides = await getPendingFavoriteOverridesLocal(db, [climb.uuid], currentUserId);
                    pendingFavorite = pendingOverrides.get(climb.uuid);
                  } catch {
                    // An unavailable local outbox still permits the network read.
                  }
                  assertCurrentCredentials();
                }
                // Another heart can move while the outbox read is in flight.
                const cached = queryClient.getQueryData<FavoritesQueryResponse>(queryKey);
                if (cached) return cached;
                // This also preserves cold-start/dead-letter intent, even if the
                // drainer acknowledges its row before a server response arrives.
                if (pendingFavorite !== undefined) {
                  return { favorites: pendingFavorite ? [climb.uuid] : [] };
                }
                const response = await offlineAwareRequest<FavoritesQueryResponse>(GET_FAVORITES, {
                  boardName,
                  climbUuids: [climb.uuid],
                  angle,
                });
                assertCurrentCredentials();
                return queryClient.getQueryData<FavoritesQueryResponse>(queryKey) ?? response;
              },
            });
      void favoriteResolution
        .then((response) => {
          assertCurrentCredentials();
          // Two cold actions share the lookup but each keeps its toggle.
          // The first toggle moves this primary entry synchronously, so
          // the next continuation must read it again rather than restore
          // their shared lookup's older answer.
          const latestFavoriteResponse = queryClient.getQueryData<FavoritesQueryResponse>(queryKey);
          if (latestFavoriteResponse === undefined) queryClient.setQueryData(queryKey, response);
          assertCurrentCredentials();
          toggleKnownFavorite((latestFavoriteResponse ?? response).favorites.includes(climb.uuid));
        })
        .catch((error: unknown) => {
          if (credentialScope === getCredentialGeneration()) {
            reportHandledError(error, { tags: { source: 'climb-menu', op: 'favorite' } });
          }
        });
    };

    // What each action does. Which of them a menu offers, in what order and
    // under which label is `buildClimbMenuItems`'s call alone; this table never
    // decides visibility, so the two can't drift apart. A command whose input a
    // caller didn't pass (no queue opener, no History slot) is never offered.
    const commands: Record<ClimbActionId, () => void> = {
      playNext: () => {
        // Fire-and-forget: the cross-board prompt (when it fires) sits above
        // the dismissed sheet, so `after()` must not wait on it. A slot that is
        // not in this queue (a board-sheet row from another climber's session)
        // matches by climb instead, so the copy already in Up next moves rather
        // than a second copy landing.
        void playNext({
          item: { uuid: randomUUID(), climb },
          queueItemUuid: resolveQueuedSlotUuid(getQueueSnapshot().queue, queueItemUuid),
        });
        after();
      },
      queue: () => {
        // Same fire-and-forget shape as Play next above.
        void addToQueue({ uuid: randomUUID(), climb });
        after();
      },
      openQueue: () => {
        // Close the menu first, like share: the queue sheet opens from the
        // play route, under a menu that is already on its way out.
        after();
        onOpenQueue?.();
      },
      replayFromHere: () => {
        if (!replayItem) return;
        // Walking the queue again, like the row tap: drop any list source.
        // Preview-first: unless automatic lighting is opted in (or this phone
        // drives), open the History slot as a preview that carries the replay
        // placement to Put on board. A History copy of the climb already up
        // lands as a queue sheet tap does (`resolveQueuePickLanding`): it
        // commits solo with no hold, in either orientation, and otherwise
        // reopens the climb up, since its preview would have no Put on board.
        const commitOptions = { placement: 'STEP' as const, playlistSuggestionSource: null };
        const landing = readQueuePickLanding(replayItem, {
          current: getQueueSnapshot().currentClimbQueueItem,
          inSharedSession,
        });
        if (landing === 'commit') {
          // The queue reorders in place, so the sheet stays up to show it.
          setCurrentClimb(replayItem, commitOptions);
        } else {
          openPlayDrawer(
            replayItem.climb as Climb,
            landing === 'reopen'
              ? { boardConfig, reopensCurrent: true }
              : { boardConfig, previewQueueItem: replayItem, previewCommitOptions: commitOptions },
          );
          // Nothing in the queue changes, and the player sits under the queue
          // sheet this menu opened over. Close that sheet the way its own row
          // tap does, or the replay looks dead.
          void dismissSourceSheet?.();
        }
        after();
      },
      mirror: () => {
        mirrorControl?.onToggle();
        after();
      },
      angle: () => {
        // Close the menu first, like the queue: the angle sheet opens from the
        // play route, under a menu that is already on its way out.
        after();
        onOpenAngle?.();
      },
      // The presenter belongs to this surface, above any player route.
      playlist: () => onSelectPlaylist(),
      favorite: () => {
        if (favoriteControl) favoriteControl.onToggle();
        else if (resolveFavoriteOnAction) toggleResolvedFavorite();
        else toggleKnownFavorite(isFavorited);
        after();
      },
      tick: () => {
        track(SHARED_EVENTS.QuickTickOpened, {
          ...analyticsContext,
          climbUuid: climb.uuid,
          layoutId,
          source: analyticsSource ?? 'climb_actions',
        });
        // In-tree opener (play drawer) stacks the tick sheet above the `/play`
        // modal; the root sheet can't — presenting it dismisses `/play` and the
        // tick sheet closes immediately. Both take the climb/board snapshot so a
        // live queue change can't retarget it.
        if (onTick) {
          onTick(climb, boardConfig);
        } else {
          openLogAscent({
            climb,
            climbUuid: climb.uuid,
            climbName: climb.name,
            boardName,
            angle,
            isMirror: resolveTickMirror(
              getQueueSnapshot(),
              climb,
              queueItemUuid,
              boardConfigsMatch(activeBoardConfig, boardConfig),
            ),
            isBenchmark: !!climb.benchmark_difficulty,
            baseAscensionistCount: climb.ascensionist_count ?? 0,
            layoutId,
            sizeId,
            setIds,
            consensusGradeName: climb.difficulty,
            sessionId,
          });
        }
        after();
      },
      editEntry: () => {
        onEditEntry?.();
        after();
      },
      betaVideo: () => {
        // In-tree override (play drawer) stacks the sheet above the `/play` modal;
        // the root sheet can't. Both take the climb/board snapshot so a live queue
        // change can't retarget it. See #3505.
        if (onAddBetaVideo) onAddBetaVideo(climb, boardConfig);
        else openAddBetaVideo(climb, boardConfig);
        after();
      },
      // `openEdit` claims the action before dismissing this menu, then owns
      // the source-sheet → player-route → create ordering.
      edit: () => openEdit(climb, boardConfig, after),
      // Same serialized handoff as Edit.
      fork: () => openRemix(climb, boardConfig, after),
      viewOptions: () => {
        // Close the menu first, like the queue: the sections sheet opens from
        // the play route, under a menu that is already on its way out.
        after();
        onOpenViewOptions?.();
      },
      share: () => {
        // Close the menu, then open the native share sheet (same as the play
        // drawer). .catch so a dismissed/failed share isn't an unhandled rejection.
        after();
        track(SHARED_EVENTS.ClimbShared, {
          ...analyticsContext,
          method: 'share',
          source: analyticsSource ?? 'climb_actions_menu',
          climbUuid: climb.uuid,
          boardName,
          layoutId,
        });
        void shareClimb().catch(() => {});
      },
      openInApp: () => {
        const auroraAppUrl = climbAuroraAppUrl(boardName, climb);
        if (!auroraAppUrl) return;
        // Close the menu first so it doesn't linger behind the in-app browser
        // (openBrowserAsync only resolves when the browser is closed).
        after();
        track(SHARED_EVENTS.OpenInAuroraApp, { climbUuid: climb.uuid, boardName, layoutId });
        // .catch so a browser-open rejection doesn't become an unhandled rejection.
        void WebBrowser.openBrowserAsync(auroraAppUrl).catch(() => {});
      },
      report: () => {
        // In-tree override (play drawer) stacks the sheet above the `/play`
        // modal; the root sheet can't. Both take the climb/board snapshot so a
        // live queue change can't retarget it. See #3505.
        if (onReportClimb) onReportClimb(climb, boardConfig);
        else openReportClimb(climb, boardConfig);
        after();
      },
      delete: () => {
        // Close the menu first: the confirm is a system dialog, and it must
        // not open over a menu that is on its way out.
        after();
        // Opened from `/play`, the climb on screen is the one being deleted, so
        // the player closes behind it. Everywhere else the list refetches.
        void requestDeleteClimb(climb, boardName, () => {
          if (dismissPlayerAndWait) void dismissPlayerAndWait();
        });
      },
    };

    return buildClimbMenuItems(
      {
        climb,
        boardConfig,
        currentUserId,
        isAuthenticated,
        onEditEntry,
        onOpenQueue,
        onOpenViewOptions,
        mirrorControl,
        onOpenAngle,
        favoriteControl,
      },
      { t, actionColors, activeClimbUuid, wallArchived, moderationEnabled, isFavorited, canReplay: !!replayItem },
      (id) => commands[id](),
    );
  }, [
    climb,
    boardConfig,
    queueItemUuid,
    activeClimbUuid,
    currentUserId,
    wallArchived,
    isAuthenticated,
    onEditEntry,
    onSelectPlaylist,
    onAddBetaVideo,
    onTick,
    onReportClimb,
    onOpenQueue,
    onOpenViewOptions,
    mirrorControl,
    onOpenAngle,
    moderationEnabled,
    dismissSourceSheet,
    dismissPlayerAndWait,
    after,
    t,
    actionColors,
    openRemix,
    openEdit,
    shareClimb,
    addToQueue,
    playNext,
    setCurrentClimb,
    findReplayFromHereItem,
    getQueueSnapshot,
    toggleFavoriteMutate,
    bluetoothConnected,
    isFavorited,
    favoriteControl,
    resolveFavoriteOnAction,
    queryClient,
    inSharedSession,
    analyticsSource,
    analyticsContext,
    openPlayDrawer,
    openLogAscent,
    openAddBetaVideo,
    openReportClimb,
    activeBoardConfig,
    sessionId,
    requestDeleteClimb,
  ]);
}
