// Single source of truth for the climb long-press action list, rendered by the
// `ClimbReactionMenu` overlay. Each item carries the display metadata (label, icon,
// colour) plus a `run()` that performs the action and then calls `onAfterAction` (the
// reaction menu passes its animated dismiss).
//
// The hook self-sources every opener (preview / queue / playlist / tick / beta video)
// from `useDrawerHost`, the favourite state + mutation from `useFavoriteStatus` /
// `useToggleFavorite`, the native share from `useShareClimb`, and the create-climb
// routes from the router, so a caller only
// supplies the climb, its board config, and the two contextual flags (`currentUserId`,
// `isAuthenticated`) plus the logbook-only `onEditEntry`.

import { useCallback, useMemo } from 'react';
import type { OpaqueColorValue } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useRouter } from 'expo-router';
import { randomUUID } from 'expo-crypto';
import * as WebBrowser from 'expo-web-browser';
import type { Climb } from '@boardsesh/shared-schema';
import { computeCanUpdate, type SavedClimbSnapshot } from '@boardsesh/create-climb-react';
import { SHARED_EVENTS } from '@boardsesh/analytics';
import type { IconName } from '../icon-map';
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
};

// Mirrors web's constructClimbInfoUrl: Kilter no longer has a public app URL.
function buildAuroraAppUrl(boardName: string, climbUuid: string): string | null {
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
}: UseClimbActionsArgs): ClimbActionItem[] {
  const { t } = useTranslation('climbs');
  const router = useRouter();
  const { actionColors } = useTheme();
  const { addToQueue } = useQueueActions();
  const { mutate: toggleFavoriteMutate } = useToggleFavorite();
  const {
    openPlayDrawer,
    openAddToPlaylist,
    openLogAscent,
    openAddBetaVideo,
    boardConfig: activeBoardConfig,
  } = useDrawerHost();
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
    const auroraAppUrl = buildAuroraAppUrl(boardName, climb.uuid);

    // Edit is owner-only, and only while the climb is still a draft OR within 24h of
    // first publish (the backend enforces the same window). `userId` is null for
    // Aurora-synced climbs that predate Boardsesh accounts.
    const canEdit = (() => {
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
          source: 'climb_view',
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
        addToQueue({ uuid: randomUUID(), climb });
        after();
      },
    });

    items.push({
      id: 'playlist',
      title: t('actions.playlist.popover.title'),
      icon: 'playlist',
      color: accentColor,
      run: () => {
        openAddToPlaylist(climb, boardConfig);
        after();
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
        openLogAscent({
          climbUuid: climb.uuid,
          boardName,
          angle,
          isMirror: false,
          isBenchmark: !!climb.benchmark_difficulty,
          layoutId,
          sizeId,
          setIds,
          consensusGradeName: climb.difficulty,
        });
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
          openAddBetaVideo(climb, boardConfig);
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
        run: () => {
          after();
          router.push({
            pathname: '/(tabs)/climbs/create',
            params: {
              editClimbUuid: climb.uuid,
              boardName,
              layoutId: String(layoutId),
              sizeId: String(sizeId),
              setIds,
              angle: String(angle),
            },
          });
        },
      });
    }

    items.push({
      id: 'fork',
      title: t('mobile.climbActions.fork'),
      icon: 'branch',
      color: accentColor,
      run: () => {
        after();
        router.push({
          pathname: '/(tabs)/climbs/create',
          params: {
            forkFrames: climb.frames,
            forkName: climb.name,
            forkDescription: climb.description ?? '',
            boardName,
            layoutId: String(layoutId),
            sizeId: String(sizeId),
            setIds,
            angle: String(angle),
          },
        });
      },
    });

    items.push({
      id: 'share',
      title: t('share.actionLabel'),
      icon: 'share',
      color: accentColor,
      run: () => {
        // Dismiss the overlay, then open the native share sheet (same as the play
        // drawer). .catch so a dismissed/failed share isn't an unhandled rejection.
        after();
        track(SHARED_EVENTS.ClimbShared, { method: 'share', climbUuid: climb.uuid, boardName, layoutId });
        void shareClimb().catch(() => {});
      },
    });

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
    after,
    t,
    actionColors,
    router,
    shareClimb,
    addToQueue,
    toggleFavoriteMutate,
    isFavorited,
    openPlayDrawer,
    openAddToPlaylist,
    openLogAscent,
    openAddBetaVideo,
    activeBoardConfig,
  ]);
}
