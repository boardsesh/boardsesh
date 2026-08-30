// Single source of truth for the climb long-press action list, rendered by the
// `ClimbReactionMenu` overlay. Each item carries the display metadata (label, icon,
// colour) plus a `run()` that performs the action and then calls `onAfterAction` (the
// reaction menu passes its animated dismiss).
//
// The hook self-sources most openers (preview / queue / tick / beta video) from
// `useDrawerHost`, the favourite state + mutation from `useFavoriteStatus` /
// `useToggleFavorite`, the native share from `useShareClimb`, and the create-climb
// routes from `useCreateClimbNavigation`, so a caller supplies the climb, its board
// config, the two contextual flags (`currentUserId`, `isAuthenticated`), the required
// inline playlist host (`onSelectPlaylist`), and the logbook-only `onEditEntry`.

import { useCallback, useMemo } from 'react';
import type { OpaqueColorValue } from 'react-native';
import { useTranslation } from 'react-i18next';
import { randomUUID } from 'expo-crypto';
import * as WebBrowser from 'expo-web-browser';
import type { AuroraBoardName, Climb } from '@boardsesh/shared-schema';
import { getBoardCapabilities, toAuroraBoardName } from '@boardsesh/board-config';
import { computeCanUpdate, type SavedClimbSnapshot } from '@boardsesh/create-climb-react';
import { SHARED_EVENTS } from '@boardsesh/analytics';
import type { IconName } from '../icon-map';
import { useCreateClimbNavigation, type DismissSurfaceAndWait } from '../create-climb/use-create-climb-navigation';
import { useDrawerHost, boardConfigsMatch, type BoardConfig } from '../../providers/drawer-host-provider';
import { useQueueActions } from '../../providers/queue-provider';
import { useToggleFavorite, useFavoriteStatus } from '../../lib/graphql/hooks';
import { climbToQueueItem } from '../../lib/climb-to-queue-item';
import { useTheme } from '../../providers/theme-provider';
import { useShareClimb } from '../../hooks/use-share-climb';
import { track } from '../../lib/analytics';

export type ClimbActionId =
  | 'preview'
  | 'queue'
  | 'playlist'
  | 'favorite'
  | 'tick'
  | 'editEntry'
  | 'betaVideo'
  | 'edit'
  | 'fork'
  | 'share'
  | 'openInApp';

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

type UseClimbActionsArgs = {
  climb: Climb | null;
  boardConfig: BoardConfig | null;
  /** Signed-in user id — gates the owner-only Edit action. */
  currentUserId?: string | null;
  /** Gates the "Add beta video" action. */
  isAuthenticated: boolean;
  /** When provided, adds an "Edit entry" action wired to the tick editor (logbook only). */
  onEditEntry?: () => void;
  /** Run after any action fires. The sheet passes its `onClose`; the native menu omits it. */
  onAfterAction?: () => void;
  /**
   * Required in-place host for the "Add to playlist" action: `run()` calls this
   * and does NOT dismiss the menu, so the picker renders inline (a view switch in
   * the reaction overlay's `FullWindowOverlay`) rather than opening a native
   * sheet. Deliberately NOT optional: a fallback that opened the root
   * `AddToPlaylistSheet` here would present a second native sheet off the root
   * window and, from over a modal route (`/play`), flash open and vanish — the
   * #3335 / #3294 bug (docs/mobile-sheets-vs-routes.md, rule 1 + the in-tree-opener
   * trap). Surfaces that genuinely want the standalone sheet (the climb-list row,
   * the board sheet) call `useDrawerHost().openAddToPlaylist` directly, off the
   * player, instead of going through this hook.
   */
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
  /** Native BoardSheet / QueueSheet underneath the custom overlay, if any. */
  dismissSourceSheet?: DismissSurfaceAndWait;
  /** `/play`-owned native-stack close waiter; absent for every inline surface. */
  dismissPlayerAndWait?: DismissSurfaceAndWait;
};

// Mirrors web's constructClimbInfoUrl: Kilter no longer has a public app URL.
// Aurora-only by construction — the caller gates on the auroraAppLink capability
// and narrows the board name before calling, so a code-driven board (MoonBoard,
// Woods) never reaches this and never gets an invented domain.
function buildAuroraAppUrl(boardName: AuroraBoardName, climbUuid: string): string | null {
  if (boardName === 'kilter') return null;
  const suffix = boardName === 'tension' ? '2' : '';
  return `https://${boardName}boardapp${suffix}.com/climbs/${climbUuid}`;
}

export function useClimbActions({
  climb,
  boardConfig,
  currentUserId,
  isAuthenticated,
  onEditEntry,
  onAfterAction,
  onSelectPlaylist,
  onAddBetaVideo,
  onTick,
  dismissSourceSheet,
  dismissPlayerAndWait,
}: UseClimbActionsArgs): ClimbActionItem[] {
  const { t } = useTranslation('climbs');
  const { openRemix, openEdit } = useCreateClimbNavigation({ dismissSourceSheet, dismissPlayerAndWait });
  const { actionColors } = useTheme();
  const { addToQueue } = useQueueActions();
  const { mutate: toggleFavoriteMutate } = useToggleFavorite();
  const { openPlayDrawer, openLogAscent, openAddBetaVideo, boardConfig: activeBoardConfig } = useDrawerHost();
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
  const { data: isFavorited } = useFavoriteStatus(
    boardConfig?.boardName ?? '',
    climb?.uuid ?? null,
    boardConfig?.angle ?? 0,
    {
      enabled: !!climb && !!boardConfig,
    },
  );

  const after = useCallback(() => onAfterAction?.(), [onAfterAction]);

  return useMemo<ClimbActionItem[]>(() => {
    if (!climb || !boardConfig) return [];

    const { boardName, layoutId, sizeId, setIds, angle } = boardConfig;
    const { success: successColor, favorite: favoriteColor, accent: accentColor } = actionColors;
    const boardCapabilities = getBoardCapabilities(boardName);
    // Only boards with an official app page get the row; the guard is what turns
    // the loose board string into the AuroraBoardName the builder assumes.
    const auroraBoardName = boardCapabilities.auroraAppLink ? toAuroraBoardName(boardName) : null;
    const auroraAppUrl = auroraBoardName ? buildAuroraAppUrl(auroraBoardName, climb.uuid) : null;

    // Edit is owner-only, and only while the climb is still a draft OR within 24h of
    // first publish (the backend enforces the same window). `userId` is null for
    // Aurora-synced climbs that predate Boardsesh accounts.
    const canEdit = (() => {
      if (!boardCapabilities.climbCreation) return false;
      if (!currentUserId || !climb.userId || climb.userId !== currentUserId) return false;
      const snapshot: SavedClimbSnapshot = {
        uuid: climb.uuid,
        boardType: boardName,
        createdAt: climb.created_at ?? null,
        publishedAt: climb.published_at ?? null,
        isDraft: climb.is_draft ?? false,
      };
      return computeCanUpdate(snapshot, boardName);
    })();

    const items: ClimbActionItem[] = [];

    // View-only open: a previewQueueItem (badge + "Set active") rather than committing.
    // Mirror the board-sheet override rule so a cross-board climb still renders the
    // switch-board overlay; same-board needs no override.
    items.push({
      id: 'preview',
      title: t('mobile.climbActions.preview'),
      icon: 'visibility',
      color: accentColor,
      run: () => {
        const override = boardConfigsMatch(boardConfig, activeBoardConfig) ? undefined : boardConfig;
        openPlayDrawer(climb, {
          previewQueueItem: climbToQueueItem(climb),
          boardConfig: override,
        });
        after();
      },
    });

    items.push({
      id: 'queue',
      title: t('mobile.climbRow.addToQueue'),
      icon: 'add',
      color: successColor,
      run: () => {
        // Fire-and-forget: the cross-board prompt (when it fires) sits above
        // the dismissed sheet, so `after()` must not wait on it.
        void addToQueue({ uuid: randomUUID(), climb });
        after();
      },
    });

    items.push({
      id: 'playlist',
      title: t('actions.playlist.popover.title'),
      icon: 'playlist',
      color: accentColor,
      // Always the inline host: swap the reaction overlay to its playlist view
      // (no dismiss, no second native sheet). `onSelectPlaylist` is required so
      // this action can never fall back to opening the root AddToPlaylistSheet
      // over a modal route and flash closed — the #3335 / #3294 class.
      run: () => {
        onSelectPlaylist();
      },
    });

    items.push({
      id: 'favorite',
      title: t('mobile.climbRow.toggleFavorite'),
      icon: isFavorited ? 'favorite.fill' : 'favorite',
      color: favoriteColor,
      run: () => {
        track(SHARED_EVENTS.FavoriteToggle, {
          action: isFavorited ? 'removed' : 'added',
          climbUuid: climb.uuid,
          boardName,
          layoutId,
          source: 'mobile_climb_actions',
        });
        toggleFavoriteMutate({ input: { boardName, climbUuid: climb.uuid, angle } });
        after();
      },
    });

    items.push({
      id: 'tick',
      title: t('mobile.climbActions.tick'),
      icon: 'tick',
      color: successColor,
      run: () => {
        track(SHARED_EVENTS.QuickTickOpened, { climbUuid: climb.uuid, layoutId, source: 'climb_actions' });
        // In-tree opener (play drawer) stacks the tick sheet above the `/play`
        // modal; the root sheet can't — presenting it dismisses `/play` and the
        // tick sheet closes immediately. Both take the climb/board snapshot so a
        // live queue change can't retarget it.
        if (onTick) {
          onTick(climb, boardConfig);
        } else {
          openLogAscent({
            climbUuid: climb.uuid,
            climbName: climb.name,
            boardName,
            angle,
            isMirror: false,
            isBenchmark: !!climb.benchmark_difficulty,
            baseAscensionistCount: climb.ascensionist_count ?? 0,
            layoutId,
            sizeId,
            setIds,
            consensusGradeName: climb.difficulty,
          });
        }
        after();
      },
    });

    if (onEditEntry) {
      items.push({
        id: 'editEntry',
        title: t('mobile.climbActions.editEntry'),
        icon: 'edit',
        color: accentColor,
        run: () => {
          onEditEntry();
          after();
        },
      });
    }

    if (isAuthenticated) {
      items.push({
        id: 'betaVideo',
        title: t('mobile.climbActions.addBetaVideo'),
        icon: 'video',
        color: accentColor,
        run: () => {
          // In-tree override (play drawer) stacks the sheet above the `/play` modal;
          // the root sheet can't. Both take the climb/board snapshot so a live queue
          // change can't retarget it. See #3505.
          if (onAddBetaVideo) onAddBetaVideo(climb, boardConfig);
          else openAddBetaVideo(climb, boardConfig);
          after();
        },
      });
    }

    if (canEdit) {
      items.push({
        id: 'edit',
        title: t('mobile.climbActions.edit'),
        icon: 'edit',
        color: accentColor,
        // `openEdit` claims the action before dismissing this overlay, then owns
        // the source-sheet → player-route → create ordering.
        run: () => {
          openEdit(climb, boardConfig, after);
        },
      });
    }

    // Fork drops into the create-climb editor, so it only appears on boards that
    // can have climbs set on them.
    if (boardCapabilities.climbCreation) {
      items.push({
        id: 'fork',
        title: t('mobile.climbActions.fork'),
        icon: 'branch',
        color: accentColor,
        // Same serialized handoff as Edit.
        run: () => {
          openRemix(climb, boardConfig, after);
        },
      });
    }

    if (boardCapabilities.staticBoardRender) {
      items.push({
        id: 'share',
        title: t('share.actionLabel'),
        icon: 'share',
        color: accentColor,
        run: () => {
          // Dismiss the overlay, then open the native share sheet (same as the play
          // drawer). .catch so a dismissed/failed share isn't an unhandled rejection.
          after();
          track(SHARED_EVENTS.ClimbShared, {
            method: 'share',
            source: 'climb_actions_menu',
            climbUuid: climb.uuid,
            boardName,
            layoutId,
          });
          void shareClimb().catch(() => {});
        },
      });
    }

    if (auroraAppUrl) {
      items.push({
        id: 'openInApp',
        title: t('mobile.climbActions.openInApp'),
        icon: 'open.external',
        color: accentColor,
        run: () => {
          // Dismiss the overlay first so it doesn't linger behind the in-app browser
          // (openBrowserAsync only resolves when the browser is closed).
          after();
          track(SHARED_EVENTS.OpenInAuroraApp, { climbUuid: climb.uuid, boardName, layoutId });
          // .catch so a browser-open rejection doesn't become an unhandled rejection.
          void WebBrowser.openBrowserAsync(auroraAppUrl).catch(() => {});
        },
      });
    }

    return items;
  }, [
    climb,
    boardConfig,
    currentUserId,
    isAuthenticated,
    onEditEntry,
    onSelectPlaylist,
    onAddBetaVideo,
    onTick,
    dismissSourceSheet,
    dismissPlayerAndWait,
    after,
    t,
    actionColors,
    openRemix,
    openEdit,
    shareClimb,
    addToQueue,
    toggleFavoriteMutate,
    isFavorited,
    openPlayDrawer,
    openLogAscent,
    openAddBetaVideo,
    activeBoardConfig,
  ]);
}
