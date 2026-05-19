'use client';

import React, { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { createPortal } from 'react-dom';
import MuiButton from '@mui/material/Button';
import IconButton from '@mui/material/IconButton';
import MuiCard from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import SyncOutlined from '@mui/icons-material/SyncOutlined';
import CloudOffOutlined from '@mui/icons-material/CloudOffOutlined';
import OpenInFullOutlined from '@mui/icons-material/OpenInFullOutlined';
import FormatListBulletedOutlined from '@mui/icons-material/FormatListBulletedOutlined';
import { track } from '@/app/lib/analytics';
import { useQueueActions, useCurrentClimb, useQueueList, useSessionData } from '../graphql-queue';
import QueueNavButton from './queue-nav-button';
import { usePathname, useParams, useSearchParams } from 'next/navigation';
import LocaleLink from '@/app/components/i18n/locale-link';
import {
  constructPlayUrlWithSlugs,
  getContextAwareClimbViewUrl,
  isNumericId,
  tryConstructSlugPlayUrl,
} from '@/app/lib/url-utils';
import type { BoardRouteParameters, BoardDetails, Angle, Climb } from '@/app/lib/types';
import type { ClimbQueueItem } from './types';
import { v4 as uuidv4 } from 'uuid';
import { readPlayDrawerEventDetail } from './play-drawer-event';
import QueueDrawer from '../play-view/queue-drawer';
import { useSwipeable } from 'react-swipeable';
import { TickButton } from '../logbook/tick-button';
import { TickButtonWithLabel } from '../logbook/tick-icon';
import { PersonFallingIcon } from '@/app/components/icons/person-falling-icon';
import { QuickTickBar, type QuickTickBarHandle } from '../logbook/quick-tick-bar';
import { hasPriorHistoryForClimb } from '@/app/hooks/use-tick-save';
import { useBoardProvider } from '../board-provider/board-provider-context';
import ClimbThumbnail from '../climb-card/climb-thumbnail';
import ClimbTitle from '../climb-card/climb-title';
import { themeTokens } from '@/app/theme/theme-config';
import { TOUR_CLOSE_PLAY_VIEW_EVENT } from '../onboarding/onboarding-tour-events';
import { useCardSwipeNavigation, EXIT_DURATION, SNAP_BACK_DURATION } from '@/app/hooks/use-card-swipe-navigation';
import PlayViewDrawer from '../play-view/play-view-drawer';
import CircularProgress from '@mui/material/CircularProgress';
import CloseOutlined from '@mui/icons-material/CloseOutlined';
import KeyboardArrowUpOutlined from '@mui/icons-material/KeyboardArrowUpOutlined';
import KeyboardArrowDownOutlined from '@mui/icons-material/KeyboardArrowDownOutlined';
import CheckOutlined from '@mui/icons-material/CheckOutlined';
import ChatBubbleOutlineOutlined from '@mui/icons-material/ChatBubbleOutlineOutlined';
import InputAdornment from '@mui/material/InputAdornment';
import Avatar from '@mui/material/Avatar';
import AvatarGroup from '@mui/material/AvatarGroup';
import Badge from '@mui/material/Badge';
import Lightbulb from '@mui/icons-material/Lightbulb';
import Typography from '@mui/material/Typography';
import { getGradeTintColor } from '@/app/lib/grade-colors';
import { useColorMode } from '@/app/hooks/use-color-mode';
import { useSnackbar } from '@/app/components/providers/snackbar-provider';
import { usePersistentSessionState } from '../persistent-session/persistent-session-context';
import PlayCircleOutlineOutlined from '@mui/icons-material/PlayCircleOutlineOutlined';
import { dispatchOpenSeshSettingsDrawer } from '../sesh-settings/sesh-settings-drawer-event';
import { generateSessionName } from '@/app/lib/session-utils';
import StartSeshDrawer from '../session-creation/start-sesh-drawer';
import IosShare from '@mui/icons-material/IosShare';
import { QRCodeSVG } from 'qrcode.react';
import { shareWithFallback } from '@/app/lib/share-utils';
import { getPreference, setPreference } from '@/app/lib/user-preferences-db';
import styles from './queue-control-bar.module.css';
import { PLAY_DRAWER_EVENT, dispatchOpenPlayDrawer } from './play-drawer-event';

export type ActiveDrawer = 'none' | 'play' | 'queue' | 'tick';

const QUEUE_BADGE_SX = { '& .MuiBadge-badge': themeTokens.badge.small } as const;

const TICK_BADGE_SX = {
  '& .MuiBadge-badge': {
    backgroundColor: themeTokens.colors.success,
    color: 'common.white',
    width: 16,
    height: 16,
    minWidth: 16,
    borderRadius: '50%',
    border: '2px solid transparent',
  },
} as const;

const DRIVER_BADGE_SX = {
  '& .MuiBadge-badge': {
    ...themeTokens.badge.small,
    backgroundColor: themeTokens.colors.primary,
    color: 'common.white',
    borderRadius: '50%',
    border: '2px solid transparent',
  },
} as const;

function TickBadgeAvatar({
  user,
  hasTicked,
  size = 28,
  isDriver = false,
}: {
  user: { id: string; username: string; avatarUrl?: string };
  hasTicked: boolean;
  size?: number;
  /** Queue-control-bar pivot: when true, overlay a small lit lightbulb badge
   *  on the top-right corner of the avatar so the driver is unambiguous in
   *  the bar's AvatarGroup. Composes with the tick badge (which lives
   *  bottom-right) so a driver who has also ticked the current climb shows
   *  both. */
  isDriver?: boolean;
}) {
  const { t } = useTranslation('session');
  // Accessible label: when the user is driving, screen readers should hear
  // "<username> is driving" — relying on `alt` is invisible because Avatar
  // without `src` renders the username initial as text, not an <img>. Apply
  // aria-label to the Avatar root so the SR sees it regardless of the
  // src/initials branch.
  const driverAriaLabel = isDriver ? t('queueBar.ariaLabels.userIsDriving', { username: user.username }) : undefined;
  const baseAvatar = (
    <Avatar
      alt={user.username}
      src={user.avatarUrl ?? undefined}
      aria-label={driverAriaLabel}
      sx={size !== 28 ? { width: size, height: size } : undefined}
    />
  );
  // Compose tick badge (bottom-right) inside driver badge (top-right) so both
  // can show on the same avatar without overlapping.
  const withTick = hasTicked ? (
    <Badge
      overlap="circular"
      anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
      badgeContent={<CheckOutlined sx={{ fontSize: 10 }} />}
      sx={TICK_BADGE_SX}
    >
      {baseAvatar}
    </Badge>
  ) : (
    baseAvatar
  );
  if (!isDriver) return withTick;
  return (
    <Badge
      overlap="circular"
      anchorOrigin={{ vertical: 'top', horizontal: 'right' }}
      badgeContent={<Lightbulb sx={{ fontSize: 10 }} />}
      sx={DRIVER_BADGE_SX}
    >
      {withTick}
    </Badge>
  );
}

export type QueueControlBarProps = {
  boardDetails: BoardDetails;
  angle: Angle;
};

const QueueControlBar: React.FC<QueueControlBarProps> = ({ boardDetails, angle }) => {
  const { t } = useTranslation('session');
  const pathname = usePathname();
  // Seed the drawer open on direct hits to /view/{uuid} so the SSR HTML
  // already includes the open drawer DOM. Paired with
  // `initialOpenWithoutAnimation` on PlayViewDrawer this means the drawer
  // paints immediately with no slide-in. The bar reset effect below preserves
  // this initial open by skipping its first run.
  const initialPathnameRef = useRef(pathname);
  const [activeDrawer, setActiveDrawer] = useState<ActiveDrawer>(() => (pathname.includes('/view/') ? 'play' : 'none'));
  const [startSeshOpen, setStartSeshOpen] = useState(false);
  const params = useParams<BoardRouteParameters>();
  const searchParams = useSearchParams();

  // Reset activeDrawer on navigation. Skip the very first run — when we just
  // seeded the drawer open from the URL, this would slam it shut before paint.
  useEffect(() => {
    if (pathname === initialPathnameRef.current) return;
    initialPathnameRef.current = pathname;
    setActiveDrawer('none');
  }, [pathname]);

  // Whenever the play drawer closes, clear its event-driven payload state so
  // the next open from any path (PLAY_DRAWER_EVENT or direct setActiveDrawer)
  // starts from a clean slate. Belt-and-braces vs. handleCloseDrawer which
  // only fires when the queue-list drawer's onClose runs.
  useEffect(() => {
    if (activeDrawer !== 'play') {
      setDrawerDisplayedItem(null);
      setDrawerWallView(false);
    }
  }, [activeDrawer]);

  // Tour hook: close the play view drawer on demand (e.g. before showing the
  // session overview so the two drawers don't stack).
  useEffect(() => {
    const handler = () => setActiveDrawer('none');
    window.addEventListener(TOUR_CLOSE_PLAY_VIEW_EVENT, handler);
    return () => window.removeEventListener(TOUR_CLOSE_PLAY_VIEW_EVENT, handler);
  }, []);

  const isViewPage = pathname.includes('/view/');
  const isPlayPage = pathname.includes('/play/');
  const { currentClimb } = useCurrentClimb();
  const { queue } = useQueueList();
  const {
    viewOnlyMode,
    connectionState,
    sessionId,
    isDisconnected,
    users,
    clientId,
    isPersistentSessionActive,
    driverParticipantId,
  } = useSessionData();

  // Drawer-local "displayed climb" — populated when a browse caller (list
  // row, suggestion thumbnail, logbook row) opens the drawer with a climb
  // payload while a party session is active. Null in solo (drawer reads the
  // wall climb directly), and null in party when the bar's body/thumbnail is
  // tapped (drawer also reads the wall climb in that case). Reset to null on
  // drawer close.
  const [drawerDisplayedItem, setDrawerDisplayedItem] = useState<ClimbQueueItem | null>(null);
  // Wall-view mode (pivot Phase 3): set by the bar's body-tap handler. When
  // true the drawer hides prev/next, disables swipe, and shows the
  // "Currently on the wall" header. Reset on close.
  const [drawerWallView, setDrawerWallView] = useState(false);

  // Listen for play drawer open requests from climb list items that live
  // outside this component's React tree (board page, liked list, queue
  // suggestions, queue items). When the event carries a climb payload, store
  // it as the drawer's locally-displayed item so the drawer can render the
  // requested climb. This matters in two cases:
  //   - Party sessions: browse-doesn't-yank — `previewClimbFromBrowse` uses
  //     this path so non-drivers don't change the wall climb for others.
  //   - Solo direct hits to /view/{uuid}: the page dispatches with the SSR-
  //     fetched climb so the drawer has something to display before the queue
  //     context's `currentClimbQueueItem` is seeded.
  useEffect(() => {
    const handler = (event: Event) => {
      const detail = readPlayDrawerEventDetail(event);
      const climb = detail?.climb;
      // Always store a climb payload when present — both party mode
      // (preview-doesn't-yank via previewClimbFromBrowse) and solo direct
      // hits to /view/{uuid} depend on this so the drawer has something to
      // display before the queue context's currentClimbQueueItem is seeded.
      if (climb) {
        setDrawerDisplayedItem({ climb, uuid: uuidv4(), suggested: true });
      } else {
        setDrawerDisplayedItem(null);
      }
      setDrawerWallView(!!detail?.wallView);
      setActiveDrawer('play');
    };
    window.addEventListener(PLAY_DRAWER_EVENT, handler);
    return () => window.removeEventListener(PLAY_DRAWER_EVENT, handler);
  }, []);

  const handleCloseDrawer = useCallback(() => {
    setActiveDrawer('none');
  }, []);
  const { activeSession, session: persistentSession, users: sessionUsers } = usePersistentSessionState();
  const {
    mirrorClimb,
    getNextClimbQueueItem,
    getPreviousClimbQueueItem,
    setCurrentClimbQueueItem,
    endSession,
    disconnect,
  } = useQueueActions();
  const handleThumbnailClick = useCallback(() => {
    if (!currentClimb || viewOnlyMode) return;
    // No-payload dispatch + wallView flag: drawer falls back to the wall
    // climb (the bar's own thumbnail mirrors the wall) and opens in
    // wall-view mode — "Currently on the wall" header, no prev/next, no
    // swipe. Lightbulb + standard climb actions remain (pivot Phase 3).
    dispatchOpenPlayDrawer(undefined, { wallView: true });
  }, [currentClimb, viewOnlyMode]);

  const { showMessage } = useSnackbar();
  const [showCancelConfirm, setShowCancelConfirm] = useState(false);
  const [dismissedDisconnect, setDismissedDisconnect] = useState(false);

  const { logbook } = useBoardProvider();

  // Tick-bar comment state lives here so the comment field can render in a
  // separate bar *above* the queue control bar without reflowing the main bar.
  // QuickTickBar reads the value back out via props when saving the tick.
  const [tickComment, setTickComment] = useState('');
  const [tickCommentFocused, setTickCommentFocused] = useState(false);
  const [isFlash, setIsFlash] = useState(() => !!currentClimb && !hasPriorHistoryForClimb(currentClimb, logbook));
  const [ascentType, setAscentType] = useState<'flash' | 'send' | 'attempt'>(() => (isFlash ? 'flash' : 'send'));
  const quickTickBarRef = useRef<QuickTickBarHandle>(null);

  // Whether the tick bar is in expanded mode (all pickers visible).
  const [tickBarExpanded, setTickBarExpanded] = useState(false);

  // Swipe-to-dismiss state — tracks vertical offset during down-swipe gesture.
  const [tickSwipeOffset, setTickSwipeOffset] = useState(0);

  // Keep the tick row mounted during the close animation so it can collapse.
  const [tickRowVisible, setTickRowVisible] = useState(false);
  const [participantsExpanded, setParticipantsExpanded] = useState(false);

  const sessionShareUrl = activeSession?.sessionId
    ? `${typeof window !== 'undefined' ? window.location.origin : ''}/join/${activeSession.sessionId}`
    : '';

  const handleInviteShare = useCallback(async () => {
    if (!sessionShareUrl) return;
    await shareWithFallback({
      url: sessionShareUrl,
      title: t('settings.share.shareTitle'),
      text: t('settings.share.shareText'),
      trackingEvent: 'Session Shared',
      trackingProps: { sessionId: activeSession?.sessionId ?? '' },
      onClipboardSuccess: () => showMessage(t('queueBar.linkCopied'), 'success'),
      onError: () => showMessage(t('queueBar.shareFailed'), 'error'),
    });
  }, [sessionShareUrl, activeSession?.sessionId, showMessage, t]);

  // Local tracking of which climbs the current user ticked this session,
  // since the backend doesn't populate tickedBy on queue items.
  const [localTickedClimbs, setLocalTickedClimbs] = useState<Set<string>>(() => new Set());
  const handleTickCommentFocus = useCallback(() => setTickCommentFocused(true), []);
  const handleTickCommentBlur = useCallback(() => setTickCommentFocused(false), []);

  // Reset dismissed state when connection is restored so banner reappears on next disconnect
  useEffect(() => {
    if (!isDisconnected) {
      setDismissedDisconnect(false);
    }
  }, [isDisconnected]);

  const { mode } = useColorMode();
  const isDark = mode === 'dark';

  // Show reconnecting UI only when online but WebSocket is down.
  // When truly offline (browser has no network), show normal controls with an offline indicator instead.
  const isReconnecting =
    !!sessionId &&
    !isDisconnected &&
    (connectionState === 'reconnecting' || connectionState === 'stale' || connectionState === 'error');

  // Getter is useCallback(..., [])-stable but reads latestRef internally — call
  // directly so we don't freeze a stale value into a never-invalidated memo.
  const nextClimb = getNextClimbQueueItem();
  const previousClimb = getPreviousClimbQueueItem();

  // Declared up here (above the `isReconnecting` early return below) so the
  // hook order stays stable across renders.
  const openQueueDrawer = useCallback(() => setActiveDrawer('queue'), []);
  const queueIconButton = useMemo(
    () => (
      <div
        className={styles.queueIconWrapper}
        onClick={(e) => {
          e.stopPropagation();
          openQueueDrawer();
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.stopPropagation();
            openQueueDrawer();
          }
        }}
        role="button"
        tabIndex={0}
        aria-label={t('common:ariaLabels.openQueue')}
      >
        <IconButton size="small" component="span" tabIndex={-1} sx={{ p: 0.25 }}>
          <Badge
            badgeContent={queue.length}
            max={99}
            color="primary"
            invisible={queue.length === 0}
            sx={QUEUE_BADGE_SX}
          >
            <FormatListBulletedOutlined sx={{ fontSize: 18 }} />
          </Badge>
        </IconButton>
      </div>
    ),
    [openQueueDrawer, queue.length, t],
  );
  const shouldNavigate = isViewPage || isPlayPage;

  // Build URL for a climb item (for navigation on view/play pages)
  const buildClimbUrl = useCallback(
    (climb: { uuid: string; name: string }) => {
      let climbUrl: string | null = null;

      if (isPlayPage) {
        if (boardDetails?.layout_name && boardDetails?.size_name && boardDetails?.set_names) {
          climbUrl = constructPlayUrlWithSlugs(
            boardDetails.board_name,
            boardDetails.layout_name,
            boardDetails.size_name,
            boardDetails.size_description,
            boardDetails.set_names,
            angle,
            climb.uuid,
            climb.name,
          );
        } else if (params.board_name) {
          const numericFallback = `/${params.board_name}/${params.layout_id}/${params.size_id}/${params.set_ids}/${params.angle}/play/${climb.uuid}`;
          climbUrl = isNumericId(params.layout_id)
            ? (tryConstructSlugPlayUrl(
                params.board_name,
                Number(params.layout_id),
                Number(params.size_id),
                decodeURIComponent(params.set_ids).split(',').map(Number),
                angle,
                climb.uuid,
                climb.name,
              ) ?? numericFallback)
            : numericFallback;
        } else {
          climbUrl = null;
        }
      } else {
        climbUrl = getContextAwareClimbViewUrl(pathname, boardDetails, angle, climb.uuid, climb.name);
      }

      if (!climbUrl) return null;

      // Preserve search params in play mode
      if (isPlayPage) {
        const queryString = searchParams.toString();
        if (queryString) {
          climbUrl = `${climbUrl}?${queryString}`;
        }
      }
      return climbUrl;
    },
    [pathname, boardDetails, angle, params, searchParams, isPlayPage],
  );

  // Handle swipe navigation. On /play/ the URL is the source of truth — push
  // the new climb's play URL. On /view/ useDrawerUrlSync owns URL state via
  // the drawer's open lifecycle; navigating here would race its cleanup and
  // close the drawer mid-swipe. Other pages (e.g. /list) get queue-only
  // updates as before.
  const handleSwipeNext = useCallback(() => {
    if (!nextClimb || viewOnlyMode) return;

    setCurrentClimbQueueItem(nextClimb);
    track('Queue Navigation', {
      direction: 'next',
      method: 'swipeQueueBar',
      boardLayout: boardDetails?.layout_name || '',
    });

    if (isPlayPage) {
      const url = buildClimbUrl(nextClimb.climb);
      if (url) window.history.pushState(null, '', url);
    }
  }, [nextClimb, viewOnlyMode, setCurrentClimbQueueItem, buildClimbUrl, boardDetails, isPlayPage]);

  const handleSwipePrevious = useCallback(() => {
    if (!previousClimb || viewOnlyMode) return;

    setCurrentClimbQueueItem(previousClimb);
    track('Queue Navigation', {
      direction: 'previous',
      method: 'swipeQueueBar',
      boardLayout: boardDetails?.layout_name || '',
    });

    if (isPlayPage) {
      const url = buildClimbUrl(previousClimb.climb);
      if (url) window.history.pushState(null, '', url);
    }
  }, [previousClimb, viewOnlyMode, setCurrentClimbQueueItem, buildClimbUrl, boardDetails, isPlayPage]);

  const tickBarActive = activeDrawer === 'tick';
  const canSwipeNext = !viewOnlyMode && !!nextClimb && !tickBarActive;
  const canSwipePrevious = !viewOnlyMode && !!previousClimb && !tickBarActive;

  // Snapshot the displayed climb when tick mode opens so the queue bar stays
  // frozen on the climb being ticked, even if another user advances the queue.
  const [tickClimb, setTickClimb] = useState<Climb | null>(null);
  useEffect(() => {
    if (tickBarActive && currentClimb && !tickClimb) {
      setTickClimb(currentClimb);
    } else if (!tickBarActive) {
      setTickClimb(null);
    }
  }, [tickBarActive, currentClimb, tickClimb]);

  // The climb shown in the queue bar — frozen during tick mode.
  const displayedClimb = tickBarActive ? (tickClimb ?? currentClimb) : currentClimb;
  const gradeTintColor = useMemo(
    () => getGradeTintColor(displayedClimb?.difficulty, 'default', isDark),
    [displayedClimb?.difficulty, isDark],
  );
  const sessionTintColor = useMemo(
    () => getGradeTintColor(displayedClimb?.difficulty, 'session', isDark),
    [displayedClimb?.difficulty, isDark],
  );

  // Deduplicate session users by userId (stable DB UUID).
  // When userId is absent (unauthenticated), fall back to connection id
  // so distinct participants with the same display name aren't merged.
  //
  // Also sort driver-first (queue-control-bar pivot, Phase 3): the
  // participant whose `id` matches `driverParticipantId` floats to position 0
  // so the lightbulb badge on the bar's AvatarGroup unambiguously surfaces
  // who's driving. Stable sort otherwise — non-drivers keep their existing
  // order so the avatar group doesn't jitter on unrelated participant events.
  const uniqueSessionUsers = useMemo(() => {
    const seen = new Set<string>();
    const deduped = sessionUsers.filter((user) => {
      const key = user.userId ?? user.id;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    if (!driverParticipantId) return deduped;
    const driverIdx = deduped.findIndex((u) => u.id === driverParticipantId);
    if (driverIdx <= 0) return deduped;
    const reordered = [...deduped];
    const [driver] = reordered.splice(driverIdx, 1);
    reordered.unshift(driver);
    return reordered;
  }, [sessionUsers, driverParticipantId]);

  // Resolve the current user's stable userId from the session users list
  const myUserId = useMemo(() => {
    if (!clientId) return null;
    const me = sessionUsers.find((u) => u.id === clientId);
    return me?.userId ?? clientId;
  }, [sessionUsers, clientId]);

  // Track which participants have ticked the current climb.
  // Merges backend-provided tickedBy with locally tracked ticks.
  // Uses both connection IDs and stable userIds so the badge matches
  // regardless of which ID the avatar was deduped with.
  const tickedBySet = useMemo(() => {
    const climbUuid = currentClimb?.uuid;
    const currentQueueItem = queue.find((item) => item.climb.uuid === climbUuid);
    const set = new Set(currentQueueItem?.tickedBy ?? []);
    if (myUserId && climbUuid && localTickedClimbs.has(climbUuid)) {
      set.add(myUserId);
    }
    return set;
  }, [queue, currentClimb?.uuid, myUserId, localTickedClimbs]);

  // Reset local tick cache when the active session changes
  useEffect(() => {
    setLocalTickedClimbs(new Set());
  }, [sessionId]);

  // One-time swipe hint on the queue bar — briefly peek the text left
  // twice to show users they can swipe to navigate between queued climbs.
  // Triggers when there's an active climb (suggestions provide next/prev).
  const queueHintPlayedRef = useRef(false);
  useEffect(() => {
    if (!currentClimb || tickBarActive || queueHintPlayedRef.current) return;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const animations: Animation[] = [];

    const peekOnce = (el: HTMLElement): Promise<void> => {
      const slideOut = el.animate([{ transform: 'translateX(0)' }, { transform: 'translateX(-40px)' }], {
        duration: 350,
        easing: 'ease-out',
        fill: 'forwards',
      });
      animations.push(slideOut);

      return slideOut.finished
        .then(() => {
          if (cancelled) return;
          return new Promise<void>((r) => {
            timer = setTimeout(r, 500);
          });
        })
        .then(() => {
          if (cancelled) return;
          const slideBack = el.animate([{ transform: 'translateX(-40px)' }, { transform: 'translateX(0)' }], {
            duration: 250,
            easing: 'ease-out',
            fill: 'forwards',
          });
          animations.push(slideBack);
          return slideBack.finished as Promise<unknown> as Promise<void>;
        });
    };

    void getPreference<boolean>('swipeHint:queueBarSeen').then((seen) => {
      if (cancelled || seen) return;
      if (!window.matchMedia('(pointer: coarse)').matches) return;

      timer = setTimeout(async () => {
        if (cancelled) return;
        const el = document.getElementById('onboarding-queue-toggle');
        if (!el) return;

        queueHintPlayedRef.current = true;

        try {
          await peekOnce(el);
          if (cancelled) return;
          await new Promise<void>((r) => {
            timer = setTimeout(r, 300);
          });
          if (cancelled) return;
          await peekOnce(el);
          if (cancelled) return;
          el.style.transform = '';
          void setPreference('swipeHint:queueBarSeen', true);
        } catch {
          /* cancelled */
        }
      }, 800);
    });

    return () => {
      cancelled = true;
      clearTimeout(timer);
      for (const a of animations) a.cancel();
    };
  }, [currentClimb, tickBarActive]);

  // Restore persisted tick bar expanded state when tick mode opens
  useEffect(() => {
    if (tickBarActive) {
      void getPreference<boolean>('tickBarExpanded').then((persisted) => {
        if (persisted === true) setTickBarExpanded(true);
      });
    }
  }, [tickBarActive]);

  // Persist expanded state on user-initiated toggle (not on automatic resets)
  const handleTickBarExpandedChange = useCallback((expanded: boolean) => {
    setTickBarExpanded(expanded);
    void setPreference('tickBarExpanded', expanded);
  }, []);

  // Close expanded participants when tick mode opens
  useEffect(() => {
    if (tickBarActive) setParticipantsExpanded(false);
  }, [tickBarActive]);

  // Reset all tick-bar state on close; keep the row mounted during the 200ms collapse.
  useEffect(() => {
    if (tickBarActive) {
      setTickRowVisible(true);
    } else {
      setTickSwipeOffset(0);
      setIsFlash(false);
      setAscentType('send');
      setTickBarExpanded(false);
      const timer = setTimeout(() => {
        setTickRowVisible(false);
        setTickComment('');
        setTickCommentFocused(false);
      }, 200);
      return () => clearTimeout(timer);
    }
  }, [tickBarActive]);

  const tickSwipeEnabled = tickBarActive && !tickCommentFocused;

  const tickDismissHandlers = useSwipeable({
    onSwiping: (eventData) => {
      if (!tickSwipeEnabled) return;
      const target = eventData.event.target as HTMLElement | null;
      if (target?.closest('[data-scrollable-picker]')) return;
      if (Math.abs(eventData.deltaX) > Math.abs(eventData.deltaY)) return;
      if (tickBarExpanded) {
        // Expanded: only track downward
        if (eventData.deltaY > 0) setTickSwipeOffset(eventData.deltaY);
        else setTickSwipeOffset(0);
      } else {
        // Compact: track both directions
        setTickSwipeOffset(eventData.deltaY);
      }
    },
    onSwipedUp: (eventData) => {
      if (!tickSwipeEnabled) return;
      const target = eventData.event.target as HTMLElement | null;
      if (target?.closest('[data-scrollable-picker]')) return;
      if (!tickBarExpanded && Math.abs(eventData.deltaY) >= 50) {
        handleTickBarExpandedChange(true);
      }
      setTickSwipeOffset(0);
    },
    onSwipedDown: (eventData) => {
      if (!tickSwipeEnabled) return;
      const target = eventData.event.target as HTMLElement | null;
      if (target?.closest('[data-scrollable-picker]')) return;
      if (tickBarExpanded) {
        if (Math.abs(eventData.deltaY) >= 120 || eventData.velocity > 0.5) {
          setActiveDrawer('none');
        } else if (Math.abs(eventData.deltaY) >= 50) {
          handleTickBarExpandedChange(false);
        }
      } else {
        if (Math.abs(eventData.deltaY) >= 80) {
          setActiveDrawer('none');
        }
      }
      setTickSwipeOffset(0);
    },
    onSwiped: (eventData) => {
      if (!tickSwipeEnabled) return;
      const target = eventData.event.target as HTMLElement | null;
      if (target?.closest('[data-scrollable-picker]')) return;
      if (eventData.dir !== 'Down' && eventData.dir !== 'Up') setTickSwipeOffset(0);
    },
    trackMouse: false,
    preventScrollOnSwipe: false,
    delta: 10,
  });

  const tickDismissStyle = useMemo<React.CSSProperties | undefined>(() => {
    if (tickSwipeOffset === 0) {
      return { transition: 'grid-template-rows 200ms ease-out, opacity 200ms ease-out' };
    }
    // Only apply visual dismiss feedback for downward swipes (positive offset).
    // Upward swipes (negative offset) snap back — the expand animation handles the visual.
    if (tickSwipeOffset < 0) {
      return { transition: 'grid-template-rows 200ms ease-out, opacity 200ms ease-out' };
    }
    const fraction = Math.max(0, 1 - tickSwipeOffset / 150);
    return { gridTemplateRows: `${fraction}fr`, opacity: fraction, transition: 'none' };
  }, [tickSwipeOffset]);

  const { swipeHandlers, swipeOffset, isAnimating, animationDirection, enterDirection } = useCardSwipeNavigation({
    onSwipeNext: handleSwipeNext,
    onSwipePrevious: handleSwipePrevious,
    canSwipeNext,
    canSwipePrevious,
    threshold: 80,
    delayNavigation: true,
  });

  const playUrl = useMemo(() => {
    if (!currentClimb) return null;

    const { layout_name, size_name, size_description, set_names, board_name } = boardDetails;

    let baseUrl: string | null;
    if (layout_name && size_name && set_names) {
      baseUrl = constructPlayUrlWithSlugs(
        board_name,
        layout_name,
        size_name,
        size_description,
        set_names,
        angle,
        currentClimb.uuid,
        currentClimb.name,
      );
    } else if (params.board_name) {
      const numericFallback = `/${params.board_name}/${params.layout_id}/${params.size_id}/${params.set_ids}/${params.angle}/play/${currentClimb.uuid}`;
      baseUrl = isNumericId(params.layout_id)
        ? (tryConstructSlugPlayUrl(
            params.board_name,
            Number(params.layout_id),
            Number(params.size_id),
            decodeURIComponent(params.set_ids).split(',').map(Number),
            angle,
            currentClimb.uuid,
            currentClimb.name,
          ) ?? numericFallback)
        : numericFallback;
    } else {
      return null;
    }

    const queryString = searchParams.toString();
    if (queryString) {
      return `${baseUrl}?${queryString}`;
    }
    return baseUrl;
  }, [currentClimb, boardDetails, angle, params, searchParams]);

  const handleClimbInfoClick = useCallback(() => {
    if (!currentClimb || viewOnlyMode) return;
    // Route through dispatchOpenPlayDrawer with wallView:true so the title
    // region matches the thumbnail's path. The previous direct setActiveDrawer
    // call skipped the drawer-local wallView wiring and opened the normal
    // browse drawer, even though the title region is the dominant tap target
    // for "show me what's on the wall right now."
    dispatchOpenPlayDrawer(undefined, { wallView: true });
    track('Play Drawer Opened', {
      boardLayout: boardDetails.layout_name || '',
      source: 'bar_tap',
    });
  }, [currentClimb, viewOnlyMode, boardDetails.layout_name]);

  // Transition style shared by current and peek text
  const getTextTransitionStyle = () => {
    // After navigation completes, snap instantly (no transition) to avoid
    // the new text sliding in from the old exit position
    if (enterDirection) return 'none';
    if (isAnimating) return `transform ${EXIT_DURATION}ms ease-out`;
    if (swipeOffset === 0) return `transform ${SNAP_BACK_DURATION}ms ease-out`;
    return 'none';
  };

  // Peek: determine which climb to preview during swipe
  const showPeek = swipeOffset !== 0 || isAnimating;
  const peekIsNext = animationDirection === 'left' || (animationDirection === null && swipeOffset < 0);
  const peekClimbData = peekIsNext ? nextClimb?.climb : previousClimb?.climb;

  // Peek transform: positioned one container-width away, moves with swipeOffset.
  // Clamped so the peek stops at position 0 and never overshoots past it
  // (the exit offset is window.innerWidth which is wider than the clip container).
  const getPeekTransform = () => {
    return peekIsNext
      ? `translateX(max(0px, calc(100% + ${swipeOffset}px)))`
      : `translateX(min(0px, calc(-100% + ${swipeOffset}px)))`;
  };

  const reconnectMessage =
    connectionState === 'error' ? t('queueBar.reconnect.connectionError') : t('queueBar.reconnect.reconnecting');

  const handleLeaveSession = useCallback(() => {
    if (endSession) {
      endSession();
      return;
    }
    if (disconnect) {
      disconnect();
    } else {
      showMessage(t('queueBar.leaveFailed'), 'warning');
    }
  }, [endSession, disconnect, showMessage, t]);

  // Reconnect-only view helpers
  const renderReconnectingRow = () => (
    <div className={styles.reconnectRow}>
      <CircularProgress size={16} thickness={5} />
      <span>{reconnectMessage}</span>
      <MuiButton variant="text" size="small" onClick={() => setShowCancelConfirm(true)}>
        {t('queueBar.cancelReconnect')}
      </MuiButton>
    </div>
  );

  const renderConfirmRow = () => (
    <div className={styles.reconnectRow}>
      <span className={styles.confirmText}>{t('queueBar.cancelReconnectConfirm')}</span>
      <IconButton
        aria-label={t('queueBar.ariaLabels.leaveSession')}
        color="error"
        onClick={() => {
          handleLeaveSession();
          setShowCancelConfirm(false);
        }}
      >
        <CloseOutlined />
      </IconButton>
      <IconButton aria-label={t('queueBar.ariaLabels.keepReconnecting')} onClick={() => setShowCancelConfirm(false)}>
        <CheckOutlined />
      </IconButton>
    </div>
  );

  useEffect(() => {
    if (!isReconnecting) {
      setShowCancelConfirm(false);
    }
  }, [isReconnecting]);

  const reconnectView = (
    <MuiCard variant="outlined" className={styles.card} sx={{ border: 'none', backgroundColor: 'transparent' }}>
      <CardContent sx={{ p: 0, '&:last-child': { pb: 0 } }}>
        <div className={styles.swipeWrapper}>
          <div
            className={styles.swipeContainer}
            style={{
              padding: `${themeTokens.spacing[2]}px ${themeTokens.spacing[3]}px`,
              backgroundColor: gradeTintColor ?? (isDark ? 'transparent' : 'var(--semantic-surface)'),
            }}
          >
            <Box sx={{ display: 'flex', flexWrap: 'nowrap', alignItems: 'center' }} className={styles.row}>
              <Box sx={{ flex: 1 }} className={styles.climbInfoCol}>
                <div className={styles.climbInfoInner} style={{ gap: themeTokens.spacing[2] }}>
                  <div className={`${styles.boardPreviewContainer} ${enterDirection ? styles.thumbnailEnter : ''}`}>
                    <ClimbThumbnail
                      boardDetails={boardDetails}
                      currentClimb={displayedClimb}
                      pathname={pathname}
                      onClick={handleThumbnailClick}
                    />
                  </div>

                  {/* Reconnect UI sits where the title normally lives */}
                  <div className={styles.textSwipeClip}>
                    {showCancelConfirm ? renderConfirmRow() : renderReconnectingRow()}
                  </div>
                </div>
              </Box>
            </Box>
          </div>
        </div>
      </CardContent>
    </MuiCard>
  );

  if (isReconnecting) {
    return (
      <div id="onboarding-queue-bar" className={`queue-bar-shadow ${styles.queueBar}`} data-testid="queue-control-bar">
        {reconnectView}
      </div>
    );
  }

  let offlineBannerText: string;
  if (!sessionId) {
    offlineBannerText = t('queueBar.offline.idle');
  } else if (users && users.length > 1) {
    offlineBannerText = t('queueBar.offline.party');
  } else {
    offlineBannerText = t('queueBar.offline.solo');
  }

  return (
    <div id="onboarding-queue-bar" className={`queue-bar-shadow ${styles.queueBar}`} data-testid="queue-control-bar">
      {/* Main Control Bar */}
      <MuiCard variant="outlined" className={styles.card} sx={{ border: 'none' }}>
        <CardContent sx={{ p: 0, '&:last-child': { pb: 0 } }}>
          {/* Session header — name + avatars, or start sesh prompt.
            Uses CSS grid collapse instead of unmounting so the transition
            between session header and tick row is smooth. */}
          <div
            className={`${styles.sessionHeaderWrapper} ${!tickBarActive && !tickRowVisible ? styles.sessionHeaderExpanded : ''}`}
          >
            <div className={styles.sessionHeaderInner} data-tour-anchor="session-mini-bar">
              {/* Offline overlay on session header */}
              {isDisconnected && !dismissedDisconnect && (
                <div
                  className={styles.offlineBanner}
                  onClick={() => setDismissedDisconnect(true)}
                  role="button"
                  tabIndex={0}
                  aria-label={t('queueBar.ariaLabels.dismissOfflineNotice')}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      setDismissedDisconnect(true);
                    }
                  }}
                >
                  <CloudOffOutlined sx={{ fontSize: 14, flexShrink: 0 }} />
                  <span className={styles.offlineBannerText}>{offlineBannerText}</span>
                  <CloseOutlined sx={{ fontSize: 14, flexShrink: 0, opacity: 0.6 }} />
                </div>
              )}
              {activeSession ? (
                <div
                  className={styles.sessionHeader}
                  onClick={dispatchOpenSeshSettingsDrawer}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') dispatchOpenSeshSettingsDrawer();
                  }}
                  style={{
                    backgroundColor: sessionTintColor ?? (isDark ? 'transparent' : 'var(--semantic-surface)'),
                  }}
                >
                  <span className={styles.sessionName}>
                    {persistentSession?.name ||
                      activeSession.sessionName ||
                      generateSessionName(persistentSession?.startedAt ?? new Date().toISOString(), [
                        boardDetails.board_name,
                      ])}
                  </span>
                  {uniqueSessionUsers.length > 0 && (
                    <div
                      className={styles.avatarToggle}
                      onClick={(e) => {
                        e.stopPropagation();
                        setParticipantsExpanded((prev) => !prev);
                      }}
                      role="button"
                      tabIndex={0}
                      aria-label={
                        participantsExpanded
                          ? t('queueBar.ariaLabels.hideParticipants')
                          : t('queueBar.ariaLabels.showParticipants')
                      }
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.stopPropagation();
                          setParticipantsExpanded((prev) => !prev);
                        }
                      }}
                    >
                      {participantsExpanded ? (
                        <IconButton size="small" component="span" tabIndex={-1} sx={{ p: 0.25 }}>
                          <CloseOutlined sx={{ fontSize: 18 }} />
                        </IconButton>
                      ) : (
                        <AvatarGroup
                          max={3}
                          sx={{
                            '& .MuiAvatar-root': {
                              width: 28,
                              height: 28,
                              fontSize: 11,
                              border: '2px solid transparent',
                            },
                          }}
                        >
                          {uniqueSessionUsers.map((user) => (
                            <TickBadgeAvatar
                              key={user.id}
                              user={user}
                              hasTicked={
                                tickedBySet.has(user.id) || (user.userId != null && tickedBySet.has(user.userId))
                              }
                              isDriver={driverParticipantId != null && user.id === driverParticipantId}
                            />
                          ))}
                        </AvatarGroup>
                      )}
                    </div>
                  )}
                  {queueIconButton}
                </div>
              ) : (
                <div
                  className={styles.sessionHeader}
                  onClick={() => setStartSeshOpen(true)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') setStartSeshOpen(true);
                  }}
                  style={{
                    backgroundColor: gradeTintColor ?? (isDark ? 'transparent' : 'var(--semantic-surface)'),
                    justifyContent: 'flex-end',
                  }}
                >
                  <PlayCircleOutlineOutlined sx={{ fontSize: 16, opacity: 0.7 }} />
                  <span className={styles.sessionName}>{t('queueBar.startSesh')}</span>
                  {queueIconButton}
                </div>
              )}
              {/* Expandable participant bar — only for active sessions with participants */}
              {activeSession && uniqueSessionUsers.length > 0 && (
                <div
                  className={`${styles.participantBar} ${participantsExpanded ? styles.participantBarExpanded : ''}`}
                  style={{
                    backgroundColor: sessionTintColor ?? (isDark ? 'transparent' : 'var(--semantic-surface)'),
                  }}
                >
                  <div className={styles.participantBarInner}>
                    {uniqueSessionUsers.length === 1 ? (
                      <Box
                        sx={{
                          display: 'flex',
                          flexDirection: 'column',
                          gap: 1,
                          width: '100%',
                          px: 1,
                          py: 0.5,
                        }}
                      >
                        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                          <Typography variant="caption" color="text.secondary" sx={{ flex: 1 }}>
                            {t('settings.share.inviteCopy')}
                          </Typography>
                          <IconButton
                            size="small"
                            onClick={handleInviteShare}
                            aria-label={t('queueBar.ariaLabels.shareSessionLink')}
                          >
                            <IosShare sx={{ fontSize: 18 }} />
                          </IconButton>
                        </Box>
                        {sessionShareUrl && (
                          <Box sx={{ display: 'flex', justifyContent: 'center', py: 1 }}>
                            <QRCodeSVG value={sessionShareUrl} size={140} level="M" marginSize={4} />
                          </Box>
                        )}
                      </Box>
                    ) : (
                      <div className={styles.participantScroll}>
                        {uniqueSessionUsers.map((user) => (
                          <div key={user.id} className={styles.participantItem}>
                            <TickBadgeAvatar
                              user={user}
                              hasTicked={
                                tickedBySet.has(user.id) || (user.userId != null && tickedBySet.has(user.userId))
                              }
                              size={32}
                              isDriver={driverParticipantId != null && user.id === driverParticipantId}
                            />
                            <Typography variant="caption" className={styles.participantName} noWrap>
                              {user.username}
                            </Typography>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
          {/* Tick-mode controls — expands/collapses via CSS grid transition.
            Swipe-to-dismiss handlers are on the tick row only, not the whole card. */}
          {(tickBarActive || tickRowVisible) && (
            <div
              {...(tickBarActive ? tickDismissHandlers : {})}
              className={`${styles.tickRow} ${tickBarActive ? styles.tickRowExpanded : ''} ${tickSwipeOffset > 0 ? styles.tickRowSwiping : ''}`}
              style={{
                backgroundColor: gradeTintColor ?? (isDark ? 'transparent' : 'var(--semantic-surface)'),
                ...tickDismissStyle,
              }}
            >
              {/* Drag handle — centered across full tick bar width */}
              <div className={styles.tickDragHandleBar} />
              <div className={styles.tickRowInner}>
                {/* Toolbar: expand left, close right */}
                <div className={styles.tickDragHandleRow}>
                  <div
                    className={styles.tickExpandButton}
                    onClick={() => handleTickBarExpandedChange(!tickBarExpanded)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') handleTickBarExpandedChange(!tickBarExpanded);
                    }}
                    aria-label={tickBarExpanded ? t('queueBar.tickBar.collapseAria') : t('queueBar.tickBar.expandAria')}
                  >
                    {tickBarExpanded ? (
                      <KeyboardArrowDownOutlined sx={{ fontSize: 16, opacity: 0.7 }} />
                    ) : (
                      <KeyboardArrowUpOutlined sx={{ fontSize: 16, opacity: 0.7 }} />
                    )}
                    <span className={styles.tickExpandLabel}>
                      {tickBarExpanded ? t('queueBar.tickBar.collapse') : t('queueBar.tickBar.expand')}
                    </span>
                  </div>
                  <div className={styles.tickCloseButton}>
                    <IconButton
                      onClick={() => setActiveDrawer('none')}
                      size="small"
                      aria-label={t('queueBar.ariaLabels.closeTickBar')}
                      sx={{
                        color: 'text.primary',
                        backgroundColor: 'action.selected',
                        '&:hover': { backgroundColor: 'action.focus' },
                        padding: '2px',
                      }}
                    >
                      <CloseOutlined sx={{ fontSize: 16 }} />
                    </IconButton>
                  </div>
                </div>
                {tickBarActive && (
                  <QuickTickBar
                    ref={quickTickBarRef}
                    currentClimb={currentClimb}
                    angle={angle}
                    boardDetails={boardDetails}
                    expanded={tickBarExpanded}
                    onSave={() => {
                      if (currentClimb) {
                        setLocalTickedClimbs((prev) => new Set(prev).add(currentClimb.uuid));
                      }
                      setActiveDrawer('none');
                    }}
                    onError={() => showMessage(t('queueBar.tickError'), 'error')}
                    onDraftRestored={(draftComment) => setTickComment(draftComment)}
                    onIsFlashChange={setIsFlash}
                    onAscentTypeChange={setAscentType}
                    comment={tickComment}
                    commentSlot={
                      <div className={`${styles.tickComment} ${tickCommentFocused ? styles.tickCommentExpanded : ''}`}>
                        <TextField
                          fullWidth
                          size="small"
                          variant="outlined"
                          placeholder={t('queueBar.tickCommentPlaceholder')}
                          multiline
                          minRows={1}
                          maxRows={tickCommentFocused ? 4 : 1}
                          value={tickComment}
                          onChange={(e) => setTickComment(e.target.value)}
                          onFocus={handleTickCommentFocus}
                          onBlur={handleTickCommentBlur}
                          slotProps={{
                            htmlInput: { maxLength: 2000, 'aria-label': t('queueBar.tickBar.commentAria') },
                            input: {
                              startAdornment: (
                                <InputAdornment position="start">
                                  <ChatBubbleOutlineOutlined sx={{ fontSize: 16, opacity: 0.5 }} />
                                </InputAdornment>
                              ),
                            },
                          }}
                          sx={{
                            '& .MuiOutlinedInput-root': {
                              borderRadius: '8px',
                              backgroundColor: 'var(--input-bg)',
                              '& .MuiOutlinedInput-notchedOutline': {
                                borderColor: 'var(--neutral-200)',
                              },
                            },
                          }}
                        />
                      </div>
                    }
                    expandedCommentSlot={
                      <TextField
                        fullWidth
                        size="small"
                        variant="outlined"
                        placeholder={t('queueBar.tickCommentPlaceholder')}
                        multiline
                        minRows={2}
                        maxRows={4}
                        value={tickComment}
                        onChange={(e) => setTickComment(e.target.value)}
                        onFocus={handleTickCommentFocus}
                        onBlur={handleTickCommentBlur}
                        slotProps={{
                          htmlInput: { maxLength: 2000, 'aria-label': t('queueBar.tickBar.commentAria') },
                        }}
                        sx={{
                          '& .MuiOutlinedInput-root': {
                            borderRadius: '8px',
                            backgroundColor: 'var(--input-bg)',
                            '& .MuiOutlinedInput-notchedOutline': {
                              borderColor: 'var(--neutral-200)',
                            },
                          },
                        }}
                      />
                    }
                  />
                )}
              </div>
            </div>
          )}
          {/* Swipe container - captures swipe gestures, does NOT translate */}
          <div className={styles.swipeWrapper}>
            <div
              {...swipeHandlers}
              className={styles.swipeContainer}
              style={{
                padding: `${themeTokens.spacing[2]}px ${themeTokens.spacing[3]}px`,
                backgroundColor: gradeTintColor ?? (isDark ? 'transparent' : 'var(--semantic-surface)'),
              }}
            >
              <Box
                sx={{
                  display: 'flex',
                  flexWrap: 'nowrap',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                }}
                className={styles.row}
              >
                {/* Left section: Thumbnail and climb info */}
                <Box sx={{ flex: 1 }} className={styles.climbInfoCol}>
                  <div className={styles.climbInfoInner} style={{ gap: themeTokens.spacing[2] }}>
                    {/* Board preview — STATIC, with crossfade on enter */}
                    <div className={`${styles.boardPreviewContainer} ${enterDirection ? styles.thumbnailEnter : ''}`}>
                      <ClimbThumbnail
                        boardDetails={boardDetails}
                        currentClimb={displayedClimb}
                        pathname={pathname}
                        onClick={handleThumbnailClick}
                      />
                    </div>

                    {/* Text swipe clip — overflow hidden to contain sliding text */}
                    <div className={styles.textSwipeClip}>
                      {/* Current climb text — slides with finger. Tap opens
                          the play drawer in wall-view mode (mirrors thumbnail).
                          When the tick bar is active the title region is
                          non-interactive — no role/tabIndex so keyboard users
                          aren't fed a dead-end button.  */}
                      <div
                        id="onboarding-queue-toggle"
                        onClick={tickBarActive ? undefined : handleClimbInfoClick}
                        onKeyDown={
                          tickBarActive
                            ? undefined
                            : (e) => {
                                if (e.key === 'Enter' || e.key === ' ') {
                                  e.preventDefault();
                                  handleClimbInfoClick();
                                }
                              }
                        }
                        role={tickBarActive ? undefined : 'button'}
                        tabIndex={tickBarActive ? undefined : 0}
                        aria-label={tickBarActive ? undefined : t('queueBar.ariaLabels.openWallView')}
                        className={styles.queueToggle}
                        style={{
                          transform: tickBarActive ? undefined : `translateX(${swipeOffset}px)`,
                          transition: tickBarActive ? undefined : getTextTransitionStyle(),
                          cursor: tickBarActive ? 'default' : undefined,
                        }}
                      >
                        <ClimbTitle
                          climb={
                            displayedClimb
                              ? { ...displayedClimb, boardType: displayedClimb.boardType ?? boardDetails.board_name }
                              : displayedClimb
                          }
                          gradePosition="right"
                          showSetterInfo
                          isActive
                        />
                      </div>

                      {/* Peek text — shows next/previous climb sliding in from the edge */}
                      {!tickBarActive && showPeek && peekClimbData && (
                        <div
                          className={`${styles.queueToggle} ${styles.peekText}`}
                          style={{
                            transform: getPeekTransform(),
                            transition: getTextTransitionStyle(),
                          }}
                        >
                          <ClimbTitle
                            climb={{ ...peekClimbData, boardType: peekClimbData.boardType ?? boardDetails.board_name }}
                            gradePosition="right"
                            showSetterInfo
                          />
                        </div>
                      )}
                    </div>
                  </div>
                </Box>

                {/* Button cluster — always visible, lightbulb swaps to X in tick mode */}
                <Box sx={{ flex: 'none', marginLeft: `${themeTokens.spacing[1]}px` }}>
                  <Stack direction="row" spacing={0.5}>
                    {/* Mirror button - desktop only */}
                    {boardDetails.supportsMirroring ? (
                      <span className={styles.desktopOnly}>
                        <IconButton
                          id="button-mirror"
                          onClick={() => {
                            mirrorClimb();
                            track('Mirror Climb Toggled', {
                              boardLayout: boardDetails.layout_name || '',
                              mirrored: !displayedClimb?.mirrored,
                            });
                          }}
                          color={displayedClimb?.mirrored ? 'primary' : 'default'}
                          sx={
                            displayedClimb?.mirrored
                              ? {
                                  backgroundColor: themeTokens.colors.purple,
                                  borderColor: themeTokens.colors.purple,
                                  color: 'common.white',
                                  '&:hover': { backgroundColor: themeTokens.colors.purple },
                                }
                              : undefined
                          }
                        >
                          <SyncOutlined />
                        </IconButton>
                      </span>
                    ) : null}
                    {/* Play link - desktop only */}
                    {!isPlayPage && playUrl && (
                      <span className={styles.desktopOnly}>
                        <LocaleLink
                          href={playUrl}
                          onClick={() => {
                            track('Play Mode Entered', {
                              boardLayout: boardDetails.layout_name || '',
                            });
                          }}
                        >
                          <IconButton aria-label={t('queueBar.ariaLabels.enterPlayMode')}>
                            <OpenInFullOutlined />
                          </IconButton>
                        </LocaleLink>
                      </span>
                    )}
                    {/* Navigation buttons - desktop only */}
                    <span className={styles.navButtons}>
                      <Stack direction="row" spacing={0.5}>
                        <QueueNavButton direction="previous" navigate={shouldNavigate} boardDetails={boardDetails} />
                        <QueueNavButton direction="next" navigate={shouldNavigate} boardDetails={boardDetails} />
                      </Stack>
                    </span>
                    {/* Attempt button — visible whenever tick mode is active */}
                    {tickBarActive && (
                      <TickButtonWithLabel label={t('queueBar.tickAttemptLabel')}>
                        <IconButton
                          onClick={(e) => quickTickBarRef.current?.saveAttempt(e.currentTarget)}
                          sx={{
                            backgroundColor: themeTokens.colors.errorMuted,
                            color: themeTokens.colors.error,
                            '&:hover': { backgroundColor: themeTokens.colors.errorMutedHover },
                          }}
                          aria-label={t('queueBar.ariaLabels.logAttempt')}
                        >
                          <PersonFallingIcon />
                        </IconButton>
                      </TickButtonWithLabel>
                    )}
                    {/* Tick button — activates tick mode, or saves when already active */}
                    <TickButton
                      currentClimb={displayedClimb}
                      angle={angle}
                      boardDetails={boardDetails}
                      onActivateTickBar={() => setActiveDrawer('tick')}
                      onTickSave={(el) => quickTickBarRef.current?.save(el)}
                      tickBarActive={tickBarActive}
                      isFlash={isFlash}
                      ascentType={tickBarExpanded ? ascentType : undefined}
                    />
                  </Stack>
                </Box>
              </Box>
            </div>
          </div>
        </CardContent>
      </MuiCard>

      <QueueDrawer open={activeDrawer === 'queue'} onClose={handleCloseDrawer} boardDetails={boardDetails} />

      <PlayViewDrawer
        activeDrawer={activeDrawer}
        setActiveDrawer={setActiveDrawer}
        boardDetails={boardDetails}
        angle={angle}
        drawerDisplayedItem={drawerDisplayedItem}
        setDrawerDisplayedItem={setDrawerDisplayedItem}
        initialOpenWithoutAnimation={isViewPage}
        wallView={drawerWallView}
      />

      <StartSeshDrawer open={startSeshOpen} onClose={() => setStartSeshOpen(false)} />

      {/* Backdrop overlay — rendered via portal so it escapes the fixed bottom-bar stacking context */}
      {typeof document !== 'undefined' &&
        (tickBarActive || tickRowVisible) &&
        createPortal(
          <div
            data-testid="tick-backdrop-overlay"
            className={`${styles.tickOverlay} ${tickBarActive ? styles.tickOverlayActive : ''}`}
            onClick={() => setActiveDrawer('none')}
            aria-hidden="true"
          />,
          document.body,
        )}
    </div>
  );
};

export default React.memo(QueueControlBar);
