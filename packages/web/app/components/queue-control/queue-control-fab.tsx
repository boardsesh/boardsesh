'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import Box from '@mui/material/Box';
import Fab from '@mui/material/Fab';
import LightbulbOutlined from '@mui/icons-material/LightbulbOutlined';
import FormatListBulletedOutlined from '@mui/icons-material/FormatListBulletedOutlined';
import type { BoardDetails, Climb } from '@/app/lib/types';
import ClimbThumbnail from '../climb-card/climb-thumbnail';
import { TickIcon } from '../logbook/tick-icon';
import { useBluetoothContext } from '../board-bluetooth-control/bluetooth-context';
import { useGradeFormat } from '@/app/hooks/use-grade-format';
import { useIsDarkMode } from '@/app/hooks/use-is-dark-mode';
import { getGradeTintColor } from '@/app/lib/grade-colors';
import { themeTokens, darkTokens } from '@/app/theme/theme-config';
import styles from './queue-control-fab.module.css';

export type QueueControlFabMode = 'minimised' | 'peeking' | 'hidden';

type QueueControlFabProps = {
  mode: QueueControlFabMode;
  currentClimb: Climb | null;
  boardDetails: BoardDetails;
  pathname: string;
  /** Tap on the grade FAB — expand the queue control bar. */
  onExpandFromGrade: () => void;
  /** Tap on the climb thumbnail FAB — open the play view drawer. */
  onOpenPlayView: () => void;
  onExpandFromTick: () => void;
  /** Open the queue drawer. */
  onExpandFromQueue: () => void;
};

// Constants hoisted out so they don't allocate on every render.
const SMALL_FAB_SIZE = 46;
const SNACKBAR_EXIT_MS = 200;
const QueueControlFab: React.FC<QueueControlFabProps> = ({
  mode,
  currentClimb,
  boardDetails,
  pathname,
  onExpandFromGrade,
  onOpenPlayView,
  onExpandFromTick,
  onExpandFromQueue,
}) => {
  const { t } = useTranslation('session');
  const { formatGrade, getGradeColor, loaded: gradeLoaded } = useGradeFormat();
  const isDark = useIsDarkMode();
  const { isConnected: isBluetoothConnected, isBluetoothSupported, connect } = useBluetoothContext();

  const handleConnectBluetooth = useCallback(() => {
    void connect();
  }, [connect]);

  const isPeeking = mode === 'peeking';
  const isVisible = mode !== 'hidden';

  // Snackbar visibility tracks isPeeking but lingers SNACKBAR_EXIT_MS so the
  // exit keyframe finishes before the element unmounts.
  const [snackbarMounted, setSnackbarMounted] = useState(isPeeking);
  const [snackbarExiting, setSnackbarExiting] = useState(false);
  useEffect(() => {
    if (isPeeking) {
      setSnackbarMounted(true);
      setSnackbarExiting(false);
      return;
    }
    if (!snackbarMounted) return;
    setSnackbarExiting(true);
    const id = setTimeout(() => {
      setSnackbarMounted(false);
      setSnackbarExiting(false);
    }, SNACKBAR_EXIT_MS);
    return () => clearTimeout(id);
  }, [isPeeking, snackbarMounted]);

  const sourceGrade = currentClimb?.difficulty;
  const formattedGrade = gradeLoaded ? formatGrade(sourceGrade) : null;
  const gradeColor = formattedGrade ? getGradeColor(sourceGrade, isDark) : undefined;
  // Use the 'session' variant for a more saturated, opaque background than
  // the default queue-bar tint — the FAB needs to read clearly against the
  // page rather than fade into it.
  const gradeTintColor = getGradeTintColor(sourceGrade, 'session', isDark);
  const fabBackground = gradeTintColor ?? 'var(--semantic-surface)';
  const showBluetoothFab = isBluetoothSupported && !isBluetoothConnected;

  // Resolve glass tokens per theme. In dark mode the border / inset
  // highlight / shadow values all need to swing — the light-mode 28%
  // white border reads as a bright halo on a dark surface, and the
  // light shadow disappears against dark backgrounds. liquidGlass is
  // therefore derived per render rather than hoisted.
  const glassTokens = isDark ? darkTokens.glass : themeTokens.glass;
  const glassBg = glassTokens.background;
  const glassBgHover = glassTokens.backgroundHover;
  const liquidGlass = useMemo(
    () => ({
      backdropFilter: glassTokens.filter,
      WebkitBackdropFilter: glassTokens.filter,
      border: `1px solid ${glassTokens.border}`,
      boxShadow: `0 8px 24px ${glassTokens.shadow}, inset 0 1px 0 ${glassTokens.innerHighlight}`,
    }),
    [glassTokens.filter, glassTokens.border, glassTokens.shadow, glassTokens.innerHighlight],
  );

  // Memoised so MUI's sx shallow-compare doesn't re-style every render.
  const tickFabSx = useMemo(
    () => ({
      ...liquidGlass,
      width: SMALL_FAB_SIZE,
      height: SMALL_FAB_SIZE,
      minHeight: SMALL_FAB_SIZE,
      backgroundColor: glassBg,
      color: themeTokens.colors.success,
      '&:hover': { backgroundColor: glassBgHover },
    }),
    [liquidGlass, glassBg, glassBgHover],
  );

  const bluetoothFabSx = useMemo(
    () => ({
      ...liquidGlass,
      width: SMALL_FAB_SIZE,
      height: SMALL_FAB_SIZE,
      minHeight: SMALL_FAB_SIZE,
      backgroundColor: glassBg,
      color: themeTokens.colors.warning,
      '&:hover': { backgroundColor: glassBgHover },
    }),
    [liquidGlass, glassBg, glassBgHover],
  );

  const queueFabSx = useMemo(
    () => ({
      ...liquidGlass,
      width: SMALL_FAB_SIZE,
      height: SMALL_FAB_SIZE,
      minHeight: SMALL_FAB_SIZE,
      backgroundColor: glassBg,
      color: isDark ? themeTokens.common.white : themeTokens.neutral[800],
      '&:hover': { backgroundColor: glassBgHover },
    }),
    [liquidGlass, glassBg, glassBgHover, isDark],
  );

  const gradeFabSx = useMemo(
    () => ({
      ...liquidGlass,
      width: SMALL_FAB_SIZE,
      height: SMALL_FAB_SIZE,
      minHeight: SMALL_FAB_SIZE,
      backgroundColor: glassBg,
      color: gradeColor ?? (isDark ? themeTokens.common.white : themeTokens.neutral[800]),
      fontWeight: themeTokens.typography.fontWeight.bold,
      fontSize: themeTokens.typography.fontSize.xs,
      textTransform: 'none' as const,
      alignSelf: 'flex-end' as const,
      '&:hover': { backgroundColor: glassBgHover },
    }),
    [liquidGlass, glassBg, glassBgHover, gradeColor, isDark],
  );

  const thumbnailFabSx = useMemo(
    () => ({
      ...liquidGlass,
      width: 84,
      minWidth: 84,
      height: 84,
      minHeight: 84,
      borderRadius: '42px',
      padding: 0,
      overflow: 'hidden',
      backgroundColor: fabBackground,
      color: 'text.primary',
      transition: 'background-color 220ms ease-out',
      '&:hover': { backgroundColor: fabBackground },
    }),
    [liquidGlass, fabBackground],
  );

  if (typeof document === 'undefined') return null;
  if (!currentClimb) return null;

  return createPortal(
    <>
      {/* `inert` complements aria-hidden: aria-hidden removes the cluster
          from the a11y tree, but the FABs remain keyboard-tabbable
          underneath the expanded bar without it. inert blocks focus +
          pointer events on the whole subtree so Tab skips past them. */}
      <div
        className={`${styles.fabRoot} ${isVisible ? styles.fabRootVisible : ''}`}
        data-testid="queue-control-fab"
        aria-hidden={!isVisible}
        inert={!isVisible}
      >
        <div className={styles.leftCluster}>
          <Fab
            aria-label={t('queueBar.ariaLabels.openClimbDetails')}
            onClick={onOpenPlayView}
            className={styles.thumbnailFab}
            sx={thumbnailFabSx}
            disableRipple
          >
            <span className={styles.thumbnailWrapper}>
              <ClimbThumbnail
                boardDetails={boardDetails}
                currentClimb={currentClimb}
                pathname={pathname}
                maxHeight="72px"
              />
            </span>
          </Fab>
          {/* Grade FAB is always mounted so its slot is reserved on cold load
              when `formattedGrade` is still resolving — opacity gates the
              visual reveal so we don't shift the cluster width. */}
          <Fab
            aria-label={t('queueBar.ariaLabels.expandQueueControl')}
            onClick={onExpandFromGrade}
            className={`${styles.gradeFab} ${formattedGrade ? styles.gradeFabReady : ''}`}
            sx={gradeFabSx}
            disabled={!formattedGrade}
          >
            {formattedGrade ?? ' '}
          </Fab>
        </div>
        <div className={styles.rightCluster}>
          {showBluetoothFab && (
            <Fab
              aria-label={t('queueBar.ariaLabels.connectToBoard')}
              onClick={handleConnectBluetooth}
              className={styles.bluetoothFab}
              sx={bluetoothFabSx}
            >
              <LightbulbOutlined fontSize="small" />
            </Fab>
          )}
          <Fab
            aria-label={t('queueBar.ariaLabels.openQueue')}
            onClick={onExpandFromQueue}
            className={styles.queueFab}
            sx={queueFabSx}
          >
            <FormatListBulletedOutlined fontSize="small" />
          </Fab>
          <Fab
            aria-label={t('queueBar.ariaLabels.saveTick')}
            onClick={onExpandFromTick}
            className={styles.tickFab}
            sx={tickFabSx}
          >
            <TickIcon isFlash={false} />
          </Fab>
        </div>
      </div>
      {/* Peek snackbar: pill shaped, colorized grade tint, surfaces the
          current climb's name + setter when it changes. Sibling of fabRoot
          (not inside it) because Safari has rendering bugs with position:
          absolute children of display: flex containers. Mounted via
          snackbarMounted so the exit animation can run before unmount.
          role="status" + aria-live="polite" so screen readers announce
          the climb change in party mode without preempting other speech.
          Rendered as MUI Box so we can pass the dynamic grade tint via sx
          (project convention prefers sx over the style prop).

          Wrapped in `peekSnackbarAnchor` (a plain div) so the outer layer
          owns the fixed positioning + tab-bar-collapse translateY tracking,
          while the inner Box owns its entrance/exit keyframes. Two layers,
          two transforms, no composition headaches. Safe to put a transform
          on the wrapper because the snackbar is opaque — no backdrop-filter
          children for the transformed-ancestor containing-block to break. */}
      {snackbarMounted && (
        // `style` is used (rather than sx) purely to bridge SMALL_FAB_SIZE
        // into the stylesheet as --small-fab-size, so the anchor's bottom
        // calc stays in sync with the JS constant instead of hardcoding it.
        <div
          className={styles.peekSnackbarAnchor}
          style={{ ['--small-fab-size' as string]: `${SMALL_FAB_SIZE}px` } as React.CSSProperties}
        >
          <Box
            role="status"
            aria-live="polite"
            aria-atomic="true"
            className={`${styles.peekSnackbar} ${snackbarExiting ? styles.peekSnackbarExiting : ''}`}
            sx={{ backgroundColor: fabBackground }}
          >
            <span className={styles.peekName}>{currentClimb.name}</span>
          </Box>
        </div>
      )}
    </>,
    document.body,
  );
};

export default QueueControlFab;
