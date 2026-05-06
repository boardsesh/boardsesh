'use client';

import React, { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import IconButton from '@mui/material/IconButton';
import MenuItem from '@mui/material/MenuItem';
import ListItemIcon from '@mui/material/ListItemIcon';
import ListItemText from '@mui/material/ListItemText';
import Typography from '@mui/material/Typography';
import Divider from '@mui/material/Divider';
import TextField from '@mui/material/TextField';
import InputAdornment from '@mui/material/InputAdornment';
import ButtonBase from '@mui/material/ButtonBase';
import Popover from '@mui/material/Popover';
import ElectricBoltOutlined from '@mui/icons-material/ElectricBoltOutlined';
import MoreHorizOutlined from '@mui/icons-material/MoreHorizOutlined';
import EditOutlined from '@mui/icons-material/EditOutlined';
import DeleteOutlined from '@mui/icons-material/DeleteOutlined';
import ChatBubbleOutlineOutlined from '@mui/icons-material/ChatBubbleOutlineOutlined';
import CheckOutlined from '@mui/icons-material/CheckOutlined';
import SaveOutlined from '@mui/icons-material/SaveOutlined';
import CloseOutlined from '@mui/icons-material/CloseOutlined';
import { PersonFallingIcon } from '@/app/components/icons/person-falling-icon';
import CircularProgress from '@mui/material/CircularProgress';
import InstagramIcon from '@mui/icons-material/Instagram';
import LinkOutlined from '@mui/icons-material/LinkOutlined';
import dynamic from 'next/dynamic';
import { formatTickRelativeTime } from '@/app/lib/format-tick-time';
import { track } from '@/app/lib/analytics';
import type { AscentFeedItem } from '@/app/lib/graphql/operations/ticks';
import type { BoardDetails, BoardName } from '@/app/lib/types';
import { useOptionalQueueActions } from '@/app/components/graphql-queue';
import { dispatchOpenPlayDrawer } from '@/app/components/queue-control/play-drawer-event';
import { AscentStatusIcon } from '@/app/components/ascent-status/ascent-status-icon';
import { ClimbActions } from '@/app/components/climb-actions';
import DrawerClimbHeader from '@/app/components/climb-card/drawer-climb-header';
import { useSwipeActions, type SwipeZone } from '@/app/hooks/use-swipe-actions';
import { useDrawerDragResize } from '@/app/hooks/use-drawer-drag-resize';
import { useIsDarkMode } from '@/app/hooks/use-is-dark-mode';
import { useGradeFormat } from '@/app/hooks/use-grade-format';
import { useUpdateTick } from '@/app/hooks/use-update-tick';
import { themeTokens } from '@/app/theme/theme-config';
import { formatBoardDisplayName } from '@/app/lib/string-utils';
import { getDefaultBoardConfig } from '@/app/lib/default-board-configs';
import { getBoardDetailsForBoard } from '@/app/lib/board-utils';
import { getExcludedClimbActions } from '@/app/lib/climb-action-utils';
import { TENSION_KILTER_GRADES, getGradesForBoard } from '@/app/lib/board-data';
import AscentThumbnail from '@/app/components/activity-feed/ascent-thumbnail';
import { InlineStarPicker, InlineGradePicker, InlineTriesPicker, type ExpandedControl } from '../logbook/tick-controls';
import ClimbIcons from '@/app/components/climb-card/climb-icons';
import { ascentFeedItemToClimb } from './ascent-to-climb';
import ascentStyles from '@/app/components/climb-card/ascent-status.module.css';
import drawerCss from '@/app/components/swipeable-drawer/swipeable-drawer.module.css';
import styles from './logbook-feed-item.module.css';

const SwipeableDrawer = dynamic(() => import('../swipeable-drawer/swipeable-drawer'), {
  ssr: false,
});
const PostToInstagramDialog = dynamic(() => import('./post-to-instagram-dialog'), { ssr: false });
const AttachBetaLinkDialog = dynamic(() => import('@/app/components/beta-videos/attach-beta-link-dialog'), {
  ssr: false,
});

// Layout name mapping
const layoutNames: Record<string, string> = {
  'kilter-1': 'Kilter Original',
  'kilter-8': 'Kilter Homewall',
  'tension-9': 'Tension Classic',
  'tension-10': 'Tension 2 Mirror',
  'tension-11': 'Tension 2 Spray',
  'moonboard-1': 'MoonBoard 2010',
  'moonboard-2': 'MoonBoard 2016',
  'moonboard-3': 'MoonBoard 2024',
  'moonboard-4': 'MoonBoard Masters 2017',
  'moonboard-5': 'MoonBoard Masters 2019',
  'decoy-2': 'Decoy Dungeon Trainer',
  'touchstone-1': 'Touchstone Winter 2020',
  'grasshopper-1': 'Grasshopper 2020',
};

const getLayoutDisplayName = (boardType: string, layoutId: number | null): string => {
  if (layoutId === null) return formatBoardDisplayName(boardType);
  const key = `${boardType}-${layoutId}`;
  return layoutNames[key] || formatBoardDisplayName(boardType);
};

// Swipe thresholds
const SWIPE_THRESHOLD = 60;
const LONG_SWIPE_THRESHOLD = 150;
const MAX_SWIPE = 180;
const LEFT_ACTION_WIDTH = 180;
const RIGHT_ACTION_WIDTH = 120;

const commentBoxSx = {
  fontSize: themeTokens.typography.fontSize.xs,
  whiteSpace: 'pre-wrap',
  overflowWrap: 'anywhere',
  wordBreak: 'break-word',
  color: 'text.primary',
  backgroundColor: 'var(--neutral-100)',
  borderRadius: `${themeTokens.borderRadius.sm}px`,
  padding: `${themeTokens.spacing[1]}px ${themeTokens.spacing[2]}px`,
  marginTop: `${themeTokens.spacing[1]}px`,
} as const;

const nameSx = {
  fontSize: themeTokens.typography.fontSize.xl,
  fontWeight: themeTokens.typography.fontWeight.bold,
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
} as const;

const subtitleSx = {
  fontSize: themeTokens.typography.fontSize.xs,
  fontWeight: themeTokens.typography.fontWeight.normal,
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
} as const;

const actionsDrawerStyles = {
  wrapper: {
    width: '100%',
    touchAction: 'pan-y' as const,
    transition: 'height 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
  },
  body: { padding: `${themeTokens.spacing[2]}px 0` },
  header: {
    paddingLeft: `${themeTokens.spacing[3]}px`,
    paddingRight: `${themeTokens.spacing[3]}px`,
  },
} as const;

// --- Sub-components ---

function LogbookGradeRow({
  consensusDifficultyName,
  qualityAverage,
  difficultyName,
  quality,
  attemptCount,
  isEditing,
  editQuality,
  editDifficulty,
  editAttemptCount,
  expandedControl,
  onExpandControl,
  gradeButtonRef,
  triesButtonRef,
}: {
  consensusDifficultyName: string | null;
  qualityAverage: number | null;
  difficultyName: string | null;
  quality: number | null;
  attemptCount: number;
  isEditing?: boolean;
  editQuality?: number | null;
  editDifficulty?: number | undefined;
  editAttemptCount?: number;
  expandedControl?: ExpandedControl;
  onExpandControl?: (control: ExpandedControl) => void;
  gradeButtonRef?: React.RefObject<HTMLButtonElement | null>;
  triesButtonRef?: React.RefObject<HTMLButtonElement | null>;
}) {
  const { t } = useTranslation('profile');
  const isDark = useIsDarkMode();
  const { formatGrade, getGradeColor } = useGradeFormat();

  const consensusFormatted = consensusDifficultyName ? formatGrade(consensusDifficultyName) : null;
  const consensusColor = consensusDifficultyName ? getGradeColor(consensusDifficultyName, isDark) : undefined;
  const consensusLabel = consensusFormatted ?? consensusDifficultyName ?? '\u2014';
  const consensusStarsLabel = qualityAverage != null ? Math.round(qualityAverage).toString() : '\u2014';

  // For non-editing mode, use item values directly
  const userFormatted = difficultyName ? formatGrade(difficultyName) : null;
  const userColor = difficultyName ? getGradeColor(difficultyName, isDark) : undefined;
  const userLabel = userFormatted ?? (difficultyName || '\u2014');

  // For editing mode, look up the editDifficulty in TENSION_KILTER_GRADES
  const editGradeName = useMemo(() => {
    if (!isEditing || editDifficulty === undefined) return undefined;
    const grade = TENSION_KILTER_GRADES.find((g) => g.difficulty_id === editDifficulty);
    return grade?.difficulty_name;
  }, [isEditing, editDifficulty]);

  const editGradeFormatted = editGradeName ? formatGrade(editGradeName) : null;
  const editGradeColor = editGradeName ? getGradeColor(editGradeName, isDark) : undefined;
  const editGradeLabel = editGradeFormatted ?? (editGradeName || '\u2014');

  const handleToggle = useCallback(
    (control: ExpandedControl) => {
      if (!onExpandControl) return;
      onExpandControl(expandedControl === control ? null : control);
    },
    [onExpandControl, expandedControl],
  );

  return (
    <div className={styles.gradeRow}>
      {/* Consensus stars */}
      <div className={`${styles.statCell} ${isEditing ? styles.dimmed : ''}`}>
        <span
          className={styles.statValue}
          style={{ color: themeTokens.colors.amber }}
        >{`\u2605${consensusStarsLabel}`}</span>
        <span className={styles.statLabel}>{t('logbook.feed.stars')}</span>
      </div>
      {/* User stars */}
      {isEditing ? (
        <ButtonBase
          onClick={() => handleToggle('stars')}
          aria-label={`Quality: ${editQuality ?? 'none'}`}
          className={styles.statCell}
          disableRipple={false}
        >
          <span
            className={styles.statValue}
            style={{ color: themeTokens.colors.amber }}
          >{`\u2605${editQuality ?? '\u2014'}`}</span>
          <span className={styles.statLabel}>{t('logbook.feed.user')}</span>
        </ButtonBase>
      ) : (
        <div className={styles.statCell}>
          <span
            className={styles.statValue}
            style={{ color: themeTokens.colors.amber }}
          >{`\u2605${quality ?? '\u2014'}`}</span>
          <span className={styles.statLabel}>{t('logbook.feed.user')}</span>
        </div>
      )}
      {/* Consensus grade */}
      <div className={`${styles.gradeCell} ${isEditing ? styles.dimmed : ''}`}>
        <span className={styles.statValue} style={{ color: consensusColor }}>
          {consensusLabel}
        </span>
        <span className={styles.statLabel}>{t('logbook.feed.grade')}</span>
      </div>
      {/* User grade */}
      {isEditing ? (
        <ButtonBase
          ref={gradeButtonRef}
          onClick={() => handleToggle('grade')}
          aria-label={t('logbook.feed.selectGrade')}
          className={styles.gradeCell}
          disableRipple={false}
        >
          <span className={styles.statValue} style={{ color: editGradeColor }}>
            {editGradeLabel}
          </span>
          <span className={styles.statLabel}>{t('logbook.feed.user')}</span>
        </ButtonBase>
      ) : (
        <div className={styles.gradeCell}>
          <span className={styles.statValue} style={{ color: userColor }}>
            {userLabel}
          </span>
          <span className={styles.statLabel}>{t('logbook.feed.user')}</span>
        </div>
      )}
      {/* Tries */}
      {isEditing ? (
        <ButtonBase
          ref={triesButtonRef}
          onClick={() => handleToggle('tries')}
          aria-label={`Tries: ${editAttemptCount}`}
          className={styles.statCell}
          disableRipple={false}
        >
          <span className={styles.statValue}>{editAttemptCount}</span>
          <span className={styles.statLabel}>{t('logbook.feed.tries')}</span>
        </ButtonBase>
      ) : (
        <div className={styles.statCell}>
          <span className={styles.statValue}>{attemptCount}</span>
          <span className={styles.statLabel}>{t('logbook.feed.tries')}</span>
        </div>
      )}
    </div>
  );
}

// --- Main component ---

type LogbookFeedItemProps = {
  item: AscentFeedItem;
  showBoardType?: boolean;
  isEditing?: boolean;
  onEdit?: (item: AscentFeedItem) => void;
  onDelete?: (uuid: string) => void;
  onCancelEdit?: () => void;
  /** When true, show "Post to Instagram" option in the actions menu. */
  allowInstagramPosting?: boolean;
  /** When true, show "Link Instagram post" option in the actions menu. */
  allowInstagramLinking?: boolean;
  /** When true, tag this item so the first-visit swipe-hint animation can target it. */
  isSwipeHintTarget?: boolean;
};

const LogbookFeedItem: React.FC<LogbookFeedItemProps> = React.memo(
  ({
    item,
    showBoardType,
    isEditing,
    onEdit,
    onDelete,
    onCancelEdit,
    allowInstagramPosting,
    allowInstagramLinking,
    isSwipeHintTarget,
  }) => {
    const { t } = useTranslation('common');
    const { t: tProfile } = useTranslation('profile');
    const [isActionsOpen, setIsActionsOpen] = useState(false);
    const [instagramDialogOpen, setInstagramDialogOpen] = useState(false);
    const [betaLinkDialogOpen, setBetaLinkDialogOpen] = useState(false);

    const queueActions = useOptionalQueueActions();

    // --- Edit state ---
    const { mutateAsync: updateTickAsync, isPending: isSaving } = useUpdateTick();
    const grades = useMemo(() => getGradesForBoard(item.boardType as BoardName), [item.boardType]);

    const [editStatus, setEditStatus] = useState<'flash' | 'send' | 'attempt'>('send');
    const [editComment, setEditComment] = useState('');
    const [commentFocused, setCommentFocused] = useState(false);
    const [editQuality, setEditQuality] = useState<number | null>(null);
    const [editDifficulty, setEditDifficulty] = useState<number | undefined>(undefined);
    const [editAttemptCount, setEditAttemptCount] = useState(1);
    const [expandedControl, setExpandedControl] = useState<ExpandedControl>(null);
    const [lastExpandedControl, setLastExpandedControl] = useState<ExpandedControl>(null);
    const [pickerVisible, setPickerVisible] = useState(false);
    const [statusAnchorEl, setStatusAnchorEl] = useState<HTMLElement | null>(null);

    const gradeButtonRef = useRef<HTMLButtonElement>(null);
    const triesButtonRef = useRef<HTMLButtonElement>(null);

    // Initialize edit state from item only when transitioning into edit mode
    const wasEditingRef = useRef(false);
    useEffect(() => {
      if (isEditing && !wasEditingRef.current) {
        setEditStatus(item.status);
        setEditComment(item.comment);
        setCommentFocused(false);
        setEditQuality(item.quality ?? null);
        setEditDifficulty(item.difficulty ?? undefined);
        setEditAttemptCount(item.attemptCount);
        setExpandedControl(null);
        setLastExpandedControl(null);
        setPickerVisible(false);
        setStatusAnchorEl(null);
      }
      wasEditingRef.current = !!isEditing;
    }, [isEditing, item]);

    // Track picker visibility for collapse animation
    useEffect(() => {
      if (expandedControl) {
        setLastExpandedControl(expandedControl);
        setPickerVisible(true);
        return;
      }

      const timer = window.setTimeout(() => setPickerVisible(false), 200);
      return () => window.clearTimeout(timer);
    }, [expandedControl]);

    const renderedControl = expandedControl ?? (pickerVisible ? lastExpandedControl : null);
    const focusGradeId = editDifficulty ?? item.consensusDifficulty ?? undefined;

    // Edit handlers
    const handleStarSelect = useCallback((value: number | null) => {
      setEditQuality(value);
      setExpandedControl(null);
    }, []);

    const handleGradeSelect = useCallback((value: number | undefined) => {
      setEditDifficulty(value);
      setExpandedControl(null);
    }, []);

    const handleTriesSelect = useCallback((value: number) => {
      setEditAttemptCount(value);
      setExpandedControl(null);
    }, []);

    const handleCommentFocus = useCallback(() => {
      setExpandedControl(null);
      setCommentFocused(true);
    }, []);

    const handleCommentBlur = useCallback(() => {
      setCommentFocused(false);
    }, []);

    const handleSave = useCallback(async () => {
      try {
        await updateTickAsync({
          uuid: item.uuid,
          input: {
            status: editStatus,
            attemptCount: editAttemptCount,
            quality: editQuality ?? null,
            difficulty: editDifficulty ?? null,
            comment: editComment,
          },
        });
        onCancelEdit?.();
      } catch {
        // The mutation hook surfaces the error via snackbar; keep edit open.
      }
    }, [
      editStatus,
      editAttemptCount,
      editComment,
      editDifficulty,
      editQuality,
      item.uuid,
      onCancelEdit,
      updateTickAsync,
    ]);

    // Status picker popover
    const handleStatusBadgeClick = useCallback((e: React.MouseEvent<HTMLElement>) => {
      e.stopPropagation();
      setStatusAnchorEl(e.currentTarget);
    }, []);

    const handleStatusClose = useCallback(() => {
      setStatusAnchorEl(null);
    }, []);

    const handleStatusSelect = useCallback((status: 'flash' | 'send' | 'attempt') => {
      setEditStatus(status);
      setStatusAnchorEl(null);
    }, []);

    // Map ascent to Climb for ClimbActions + set-active handlers
    const climb = useMemo(() => ascentFeedItemToClimb(item), [item]);

    const handleRowClick = useCallback(async () => {
      if (isEditing || !queueActions) return;
      try {
        await queueActions.setCurrentClimb(climb);
        track('Logbook Row Clicked', { climbUuid: climb.uuid });
      } catch (err) {
        console.error('Failed to set active climb from logbook row', err);
      }
    }, [isEditing, queueActions, climb]);

    const handleRowKeyDown = useCallback(
      (e: React.KeyboardEvent) => {
        if (isEditing || !queueActions) return;
        if (e.key !== 'Enter' && e.key !== ' ') return;
        if (e.target !== e.currentTarget) return;
        e.preventDefault();
        void handleRowClick();
      },
      [isEditing, queueActions, handleRowClick],
    );

    const handleThumbnailClick = useCallback(
      async (e: React.MouseEvent) => {
        e.stopPropagation();
        if (isEditing || !queueActions) return;
        try {
          await queueActions.setCurrentClimb(climb);
          dispatchOpenPlayDrawer();
          track('Logbook Thumbnail Clicked', { climbUuid: climb.uuid });
        } catch (err) {
          console.error('Failed to set active climb from logbook thumbnail', err);
        }
      },
      [isEditing, queueActions, climb],
    );

    // Build BoardDetails for ClimbActions (same pattern as AscentThumbnail)
    const boardDetails = useMemo<BoardDetails | null>(() => {
      if (!item.layoutId) return null;
      const boardName = item.boardType as BoardName;
      const config = getDefaultBoardConfig(boardName, item.layoutId);
      if (!config) return null;
      try {
        return getBoardDetailsForBoard({
          board_name: boardName,
          layout_id: item.layoutId,
          size_id: config.sizeId,
          set_ids: config.setIds,
        });
      } catch {
        return null;
      }
    }, [item.boardType, item.layoutId]);

    const excludeActions = useMemo(
      () => (boardDetails ? getExcludedClimbActions(boardDetails.board_name, 'list') : []),
      [boardDetails],
    );

    // Subtitle: "2h ago . 40deg . Kilter Original"
    const subtitle = useMemo(() => {
      const parts: string[] = [];
      parts.push(formatTickRelativeTime(item.climbedAt));
      parts.push(`${item.angle}\u00B0`);
      if (showBoardType) {
        parts.push(getLayoutDisplayName(item.boardType, item.layoutId));
      }
      return parts.join(' \u00b7 ');
    }, [item.climbedAt, item.angle, showBoardType, item.boardType, item.layoutId]);

    // --- Swipe actions ---
    const handleSwipeLeft = useCallback(() => {
      onEdit?.(item);
    }, [onEdit, item]);

    const handleSwipeRightLong = useCallback(() => {
      onDelete?.(item.uuid);
    }, [onDelete, item.uuid]);

    const noop = useCallback(() => {}, []);

    // Separate ref for the left action layer DOM element so we can manipulate it directly
    const leftLayerElRef = useRef<HTMLDivElement | null>(null);

    const handleSwipeZoneChange = useCallback((zone: SwipeZone) => {
      const el = leftLayerElRef.current;
      if (!el) return;
      if (zone === 'right-long') {
        el.classList.add(styles.deleteReady);
      } else {
        el.classList.remove(styles.deleteReady);
      }
    }, []);

    const { swipeHandlers, contentRef, leftActionRef, rightActionRef } = useSwipeActions({
      onSwipeLeft: handleSwipeLeft,
      onSwipeRight: noop,
      onSwipeRightLong: handleSwipeRightLong,
      swipeThreshold: SWIPE_THRESHOLD,
      longSwipeRightThreshold: LONG_SWIPE_THRESHOLD,
      maxSwipe: MAX_SWIPE,
      maxSwipeLeft: RIGHT_ACTION_WIDTH,
      maxSwipeRight: LEFT_ACTION_WIDTH,
      disabled: isEditing,
      onSwipeZoneChange: handleSwipeZoneChange,
    });

    // Combined ref for the left action layer: hook's leftActionRef + our direct manipulation ref
    const leftActionCombinedRef = useCallback(
      (node: HTMLDivElement | null) => {
        leftLayerElRef.current = node;
        leftActionRef(node);
      },
      [leftActionRef],
    );

    // Extract stable ref from swipeHandlers to avoid re-creating the callback on every render
    // eslint-disable-next-line @typescript-eslint/unbound-method -- react-swipeable ref callback, no `this` concern
    const swipeRef = swipeHandlers.ref;
    const contentCombinedRef = useCallback(
      (node: HTMLDivElement | null) => {
        swipeRef(node);
        contentRef(node);
      },
      [swipeRef, contentRef],
    );

    // --- Actions drawer ---
    const handleOpenActions = useCallback((e: React.MouseEvent) => {
      e.stopPropagation();
      setIsActionsOpen(true);
    }, []);

    const handleCloseActions = useCallback(() => {
      setIsActionsOpen(false);
    }, []);

    const { paperRef: actionsPaperRef, dragHandlers: actionsDragHandlers } = useDrawerDragResize({
      open: isActionsOpen,
      onClose: handleCloseActions,
    });

    const handleDrawerEdit = useCallback(() => {
      handleCloseActions();
      onEdit?.(item);
    }, [handleCloseActions, onEdit, item]);

    const handleDrawerDelete = useCallback(() => {
      handleCloseActions();
      onDelete?.(item.uuid);
    }, [handleCloseActions, onDelete, item.uuid]);

    const handleOpenInstagram = useCallback(() => {
      handleCloseActions();
      setInstagramDialogOpen(true);
    }, [handleCloseActions]);

    const handleCloseInstagram = useCallback(() => {
      setInstagramDialogOpen(false);
    }, []);

    const handleOpenBetaLink = useCallback(() => {
      handleCloseActions();
      setBetaLinkDialogOpen(true);
    }, [handleCloseActions]);

    const handleCloseBetaLink = useCallback(() => {
      setBetaLinkDialogOpen(false);
    }, []);

    return (
      <>
        <div className={styles.container} id={isSwipeHintTarget ? 'onboarding-logbook-card' : undefined}>
          {/* aria-hidden: the 3-dot menu exposes Delete to assistive tech. */}
          <div ref={leftActionCombinedRef} className={styles.leftActionLayer} aria-hidden="true">
            <DeleteOutlined className={styles.swipeIcon} />
            <span className={styles.deleteLabel}>{tProfile('logbook.feed.deleteSwipeLabel')}</span>
          </div>

          {/* aria-hidden: the 3-dot menu exposes Edit to assistive tech. */}
          <div ref={rightActionRef} className={styles.rightActionLayer} aria-hidden="true" data-swipe-right-action="">
            <EditOutlined className={styles.swipeIcon} />
          </div>

          <div
            {...swipeHandlers}
            ref={contentCombinedRef}
            className={styles.swipeableContent}
            data-swipe-content=""
            role={!isEditing && queueActions ? 'button' : undefined}
            tabIndex={!isEditing && queueActions ? 0 : undefined}
            aria-label={!isEditing && queueActions ? `Set ${item.climbName} as active climb` : undefined}
            onClick={handleRowClick}
            onKeyDown={handleRowKeyDown}
          >
            <div className={styles.content}>
              {/* Thumbnail with ascent status badge */}
              <div className={styles.thumbnail}>
                {item.frames && item.layoutId && (
                  <AscentThumbnail
                    boardType={item.boardType}
                    layoutId={item.layoutId}
                    angle={item.angle}
                    climbUuid={item.climbUuid}
                    climbName={item.climbName}
                    frames={item.frames}
                    isMirror={item.isMirror}
                    onClick={queueActions && !isEditing ? handleThumbnailClick : undefined}
                  />
                )}
                {isEditing ? (
                  <ButtonBase
                    className={`${ascentStyles.badge} ${styles.statusBadgeButton}`}
                    onClick={handleStatusBadgeClick}
                    aria-label={`Change ascent status, currently ${editStatus}`}
                  >
                    <AscentStatusIcon status={editStatus} variant="badge" fontSize={12} />
                  </ButtonBase>
                ) : (
                  <div className={ascentStyles.badge} style={{ bottom: 6 }}>
                    <AscentStatusIcon status={item.status} variant="badge" fontSize={12} />
                  </div>
                )}
              </div>

              {/* Center section */}
              <div className={styles.center}>
                <Typography variant="body2" component="div" sx={nameSx}>
                  {item.climbName}
                  <ClimbIcons isNoMatch={!!item.isNoMatch} isBenchmark={!!item.isBenchmark} />
                </Typography>
                <Typography variant="body2" component="div" color="text.secondary" sx={subtitleSx}>
                  {subtitle}
                </Typography>

                {/* Picker panel (edit mode only) */}
                {isEditing && (
                  <div className={styles.pickerPanel + (expandedControl ? ' ' + styles.pickerPanelExpanded : '')}>
                    <div className={styles.pickerPanelContent}>
                      {renderedControl === 'stars' && (
                        <div className={styles.compactStarPicker}>
                          <InlineStarPicker quality={editQuality} onSelect={handleStarSelect} />
                        </div>
                      )}
                      {renderedControl === 'grade' && (
                        <InlineGradePicker
                          grades={grades}
                          currentGradeId={editDifficulty}
                          focusGradeId={focusGradeId}
                          onSelect={handleGradeSelect}
                          gradeButtonRef={gradeButtonRef}
                        />
                      )}
                      {renderedControl === 'tries' && (
                        <InlineTriesPicker
                          attemptCount={editAttemptCount}
                          onSelect={handleTriesSelect}
                          triesButtonRef={triesButtonRef}
                        />
                      )}
                    </div>
                  </div>
                )}

                <LogbookGradeRow
                  consensusDifficultyName={item.consensusDifficultyName}
                  qualityAverage={item.qualityAverage}
                  difficultyName={item.difficultyName}
                  quality={item.quality}
                  attemptCount={item.attemptCount}
                  isEditing={isEditing}
                  editQuality={editQuality}
                  editDifficulty={editDifficulty}
                  editAttemptCount={editAttemptCount}
                  expandedControl={expandedControl}
                  onExpandControl={setExpandedControl}
                  gradeButtonRef={gradeButtonRef}
                  triesButtonRef={triesButtonRef}
                />
              </div>

              {/* Menu / save-cancel buttons */}
              {isEditing ? (
                <div className={styles.editControls}>
                  <IconButton
                    size="small"
                    onClick={onCancelEdit}
                    aria-label={tProfile('logbook.feed.cancelEditing')}
                    sx={{
                      width: 44,
                      height: 44,
                      color: 'text.disabled',
                    }}
                  >
                    <CloseOutlined sx={{ fontSize: 18 }} />
                  </IconButton>
                  <IconButton
                    size="small"
                    onClick={handleSave}
                    disabled={isSaving}
                    aria-label={tProfile('logbook.feed.saveEdit')}
                    sx={{
                      width: 44,
                      height: 44,
                      backgroundColor: themeTokens.colors.success,
                      color: 'common.white',
                      '&:hover': { backgroundColor: themeTokens.colors.success },
                    }}
                  >
                    {isSaving ? <CircularProgress size={18} color="inherit" /> : <SaveOutlined sx={{ fontSize: 18 }} />}
                  </IconButton>
                </div>
              ) : (
                <IconButton
                  size="small"
                  aria-label={tProfile('logbook.feed.moreActions')}
                  onClick={handleOpenActions}
                  className={styles.menuButton}
                  disableRipple
                >
                  <MoreHorizOutlined />
                </IconButton>
              )}
            </div>

            {/* Comment area — always mounted so edit-mode toggling animates
              via grid-template-rows rather than popping in/out. */}
            <div
              className={
                !isEditing && !item.comment ? `${styles.commentRow} ${styles.commentRowEmpty}` : styles.commentRow
              }
            >
              <div className={styles.commentRowContent}>
                {isEditing ? (
                  <TextField
                    fullWidth
                    size="small"
                    variant="outlined"
                    placeholder={t('comment.shortPlaceholder')}
                    multiline
                    minRows={1}
                    maxRows={commentFocused ? 4 : 1}
                    value={editComment}
                    onChange={(event) => setEditComment(event.target.value)}
                    onFocus={handleCommentFocus}
                    onBlur={handleCommentBlur}
                    slotProps={{
                      htmlInput: { maxLength: 2000, 'aria-label': 'Edit tick comment' },
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
                        borderRadius: `${themeTokens.borderRadius.md}px`,
                        backgroundColor: 'var(--input-bg)',
                        '& .MuiOutlinedInput-notchedOutline': {
                          borderColor: 'var(--neutral-200)',
                        },
                      },
                    }}
                  />
                ) : (
                  item.comment && <Typography sx={commentBoxSx}>{item.comment}</Typography>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Status picker popover */}
        <Popover
          open={Boolean(statusAnchorEl)}
          anchorEl={statusAnchorEl}
          onClose={handleStatusClose}
          anchorOrigin={{ vertical: 'top', horizontal: 'center' }}
          transformOrigin={{ vertical: 'bottom', horizontal: 'center' }}
        >
          <MenuItem onClick={() => handleStatusSelect('flash')}>
            <ListItemIcon>
              <ElectricBoltOutlined sx={{ color: themeTokens.colors.amber }} />
            </ListItemIcon>
            <ListItemText>{tProfile('logbook.feed.status.flash')}</ListItemText>
          </MenuItem>
          <MenuItem onClick={() => handleStatusSelect('send')}>
            <ListItemIcon>
              <CheckOutlined sx={{ color: themeTokens.colors.success }} />
            </ListItemIcon>
            <ListItemText>{tProfile('logbook.feed.status.send')}</ListItemText>
          </MenuItem>
          <MenuItem onClick={() => handleStatusSelect('attempt')}>
            <ListItemIcon>
              <PersonFallingIcon sx={{ color: themeTokens.colors.error }} />
            </ListItemIcon>
            <ListItemText>{tProfile('logbook.feed.status.attempt')}</ListItemText>
          </MenuItem>
        </Popover>

        {/* Actions drawer */}
        {boardDetails && (
          <SwipeableDrawer
            title={
              <div data-swipe-blocked="" {...actionsDragHandlers} className={drawerCss.dragHeaderWrapper}>
                <DrawerClimbHeader climb={climb} boardDetails={boardDetails} />
              </div>
            }
            placement="bottom"
            height="60%"
            paperRef={actionsPaperRef}
            open={isActionsOpen}
            onClose={handleCloseActions}
            swipeEnabled={false}
            styles={actionsDrawerStyles}
          >
            {/* Edit + Delete at top */}
            {onEdit && (
              <MenuItem onClick={handleDrawerEdit}>
                <ListItemIcon>
                  <EditOutlined fontSize="small" />
                </ListItemIcon>
                <ListItemText>{tProfile('logbook.feed.editLog')}</ListItemText>
              </MenuItem>
            )}
            {onDelete && (
              <MenuItem onClick={handleDrawerDelete} sx={{ color: 'error.main' }}>
                <ListItemIcon>
                  <DeleteOutlined sx={{ color: 'error.main' }} fontSize="small" />
                </ListItemIcon>
                <ListItemText>{tProfile('logbook.feed.deleteLog')}</ListItemText>
              </MenuItem>
            )}
            {allowInstagramPosting && (
              <MenuItem onClick={handleOpenInstagram}>
                <ListItemIcon>
                  <InstagramIcon fontSize="small" />
                </ListItemIcon>
                <ListItemText>{tProfile('logbook.feed.postToInstagram')}</ListItemText>
              </MenuItem>
            )}
            {allowInstagramLinking && (
              <MenuItem onClick={handleOpenBetaLink}>
                <ListItemIcon>
                  <LinkOutlined fontSize="small" />
                </ListItemIcon>
                <ListItemText>{tProfile('logbook.feed.linkInstagramPost')}</ListItemText>
              </MenuItem>
            )}
            {(onEdit || onDelete || allowInstagramPosting || allowInstagramLinking) && <Divider />}
            {/* Standard climb actions */}
            <ClimbActions
              climb={climb}
              boardDetails={boardDetails}
              angle={item.angle}
              viewMode="list"
              exclude={excludeActions}
              onActionComplete={handleCloseActions}
            />
          </SwipeableDrawer>
        )}

        {allowInstagramPosting && (
          <PostToInstagramDialog
            open={instagramDialogOpen}
            onClose={handleCloseInstagram}
            item={
              instagramDialogOpen
                ? {
                    boardType: item.boardType,
                    climbUuid: item.climbUuid,
                    climbName: item.climbName,
                    angle: item.angle,
                  }
                : null
            }
          />
        )}
        {allowInstagramLinking && (
          <AttachBetaLinkDialog
            open={betaLinkDialogOpen}
            onClose={handleCloseBetaLink}
            boardType={item.boardType}
            climbUuid={item.climbUuid}
            climbName={item.climbName}
            angle={item.angle}
          />
        )}
      </>
    );
  },
);

LogbookFeedItem.displayName = 'LogbookFeedItem';

export default LogbookFeedItem;
