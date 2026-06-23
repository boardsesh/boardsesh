'use client';

import React, { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import MuiButton from '@mui/material/Button';
import Typography from '@mui/material/Typography';
import Rating from '@mui/material/Rating';
import LinearProgress from '@mui/material/LinearProgress';
import CircularProgress from '@mui/material/CircularProgress';
import { useSnackbar } from '@/app/components/providers/snackbar-provider';
import SwipeableDrawer from '../swipeable-drawer/swipeable-drawer';
import {
  ArrowBackOutlined,
  ArrowForwardOutlined,
  CheckOutlined,
  CheckCircle,
  OpenInFullOutlined,
  CompressOutlined,
} from '@mui/icons-material';
import { useSession } from 'next-auth/react';
import type { BoardDetails } from '@/app/lib/types';
import type { HoldRenderData } from '../board-renderer/types';
import { getImageUrl } from '../board-renderer/util';
import { themeTokens } from '@/app/theme/theme-config';
import {
  type HoldClassificationWizardProps,
  type HoldType,
  type HoldClassification,
  type StoredHoldClassification,
  HOLD_TYPE_OPTIONS,
} from './types';
import DirectionPicker from './direction-picker';
import styles from './hold-classification-wizard.module.css';

// Typography destructuring removed - using MUI Typography directly

// Zoom factor for the compact hold view (shows ~2 rows of holds)
// Higher value = more zoomed out = can see more holds around the selected one
const COMPACT_ZOOM_FACTOR = 10;
// Minimum viewport size around the hold (ensures we see enough context)
const MIN_VIEWPORT_SIZE = 200;

type HoldViewProps = {
  hold: HoldRenderData;
  boardDetails: BoardDetails;
  expanded?: boolean;
};

/**
 * Component that renders a view of a hold on the board
 * Compact mode: zoomed in showing ~2 rows around the hold
 * Expanded mode: full board with hold highlighted
 */
const HoldView: React.FC<HoldViewProps> = ({ hold, boardDetails, expanded = false }) => {
  const { boardWidth, boardHeight } = boardDetails;

  // Calculate viewBox based on mode
  let viewBox: string;
  if (expanded) {
    // Show full board
    viewBox = `0 0 ${boardWidth} ${boardHeight}`;
  } else {
    // Compact view: zoom in on the hold showing ~2 rows
    const viewSize = Math.max(hold.r * COMPACT_ZOOM_FACTOR, MIN_VIEWPORT_SIZE);
    const viewX = Math.max(0, Math.min(hold.cx - viewSize / 2, boardWidth - viewSize));
    const viewY = Math.max(0, Math.min(hold.cy - viewSize / 2, boardHeight - viewSize));
    viewBox = `${viewX} ${viewY} ${viewSize} ${viewSize}`;
  }

  // Adjust highlight sizes based on mode
  const strokeWidth = expanded ? hold.r / 2 : hold.r / 4;
  const outerRadius = expanded ? hold.r * 2 : hold.r * 1.5;
  const outerStrokeWidth = expanded ? 3 : 2;

  return (
    <svg viewBox={viewBox} preserveAspectRatio="xMidYMid meet" style={{ width: '100%', height: '100%' }}>
      {/* Board background images */}
      {Object.keys(boardDetails.images_to_holds).map((imageUrl) => (
        <image
          key={imageUrl}
          href={getImageUrl(imageUrl, boardDetails.board_name)}
          width={boardWidth}
          height={boardHeight}
        />
      ))}

      {/* Highlight the current hold */}
      <circle
        cx={hold.cx}
        cy={hold.cy}
        r={hold.r}
        style={{ stroke: 'var(--color-primary)' }}
        strokeWidth={strokeWidth}
        fill="none"
      />
      <circle
        cx={hold.cx}
        cy={hold.cy}
        r={outerRadius}
        style={{ stroke: 'var(--color-primary)' }}
        strokeWidth={outerStrokeWidth}
        fill="none"
        strokeDasharray={expanded ? '8 8' : '4 4'}
        opacity={0.5}
      />
    </svg>
  );
};

const HoldClassificationWizard: React.FC<HoldClassificationWizardProps> = ({
  open,
  onClose,
  boardDetails,
  onComplete,
}) => {
  const { t } = useTranslation('climbs');
  const { status: sessionStatus } = useSession();
  const { showMessage } = useSnackbar();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [classifications, setClassifications] = useState<Map<number, HoldClassification>>(new Map());
  const [isComplete, setIsComplete] = useState(false);
  const [isHoldViewExpanded, setIsHoldViewExpanded] = useState(false);
  const saveTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const pendingSaveRef = useRef<{ holdId: number; classification: HoldClassification } | null>(null);

  // Get holds from board details, sorted by position (top-left to bottom-right)
  const holds = useMemo(() => {
    if (!boardDetails?.holdsData) return [];
    return [...boardDetails.holdsData].sort((a, b) => {
      // Sort by row (y position) first, then by column (x position)
      const rowA = Math.floor(a.cy / 50);
      const rowB = Math.floor(b.cy / 50);
      if (rowA !== rowB) return rowA - rowB;
      return a.cx - b.cx;
    });
  }, [boardDetails?.holdsData]);

  const currentHold = holds[currentIndex];

  // Load existing classifications
  const loadClassifications = useCallback(async () => {
    if (!boardDetails) return;

    setLoading(true);
    try {
      const response = await fetch(
        `/api/internal/hold-classifications?` +
          `boardType=${boardDetails.board_name}&` +
          `layoutId=${boardDetails.layout_id}&` +
          `sizeId=${boardDetails.size_id}`,
      );

      if (response.ok) {
        const data = await response.json();
        const classMap = new Map<number, HoldClassification>();

        data.classifications.forEach((c: StoredHoldClassification) => {
          classMap.set(c.holdId, {
            holdId: c.holdId,
            holdType: c.holdType,
            handRating: c.handRating,
            footRating: c.footRating,
            pullDirection: c.pullDirection,
          });
        });

        setClassifications(classMap);
      }
    } catch (error) {
      console.error('Failed to load classifications:', error);
    } finally {
      setLoading(false);
    }
  }, [boardDetails]);

  // Load existing classifications when the wizard opens
  useEffect(() => {
    if (open && sessionStatus === 'authenticated' && boardDetails) {
      void loadClassifications();
    }
    if (open) {
      setCurrentIndex(0);
      setIsComplete(false);
    }
  }, [open, sessionStatus, boardDetails, loadClassifications]);

  // Actual save function (non-debounced)
  const doSaveClassification = useCallback(
    async (holdId: number, classification: HoldClassification) => {
      setSaving(true);
      try {
        const response = await fetch('/api/internal/hold-classifications', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            boardType: boardDetails.board_name,
            layoutId: boardDetails.layout_id,
            sizeId: boardDetails.size_id,
            holdId,
            holdType: classification.holdType,
            handRating: classification.handRating,
            footRating: classification.footRating,
            pullDirection: classification.pullDirection,
          }),
        });

        if (!response.ok) {
          throw new Error('Failed to save classification');
        }
      } catch (error) {
        console.error('Failed to save classification:', error);
        showMessage(t('holdClassification.toast.saveFailed'), 'error');
      } finally {
        setSaving(false);
      }
    },
    [boardDetails, showMessage, t],
  );

  // Debounced save - waits 500ms after last change before saving
  const saveClassification = useCallback(
    (holdId: number, classification: HoldClassification) => {
      // Store the pending save
      pendingSaveRef.current = { holdId, classification };

      // Clear any existing timeout
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
      }

      // Set new timeout
      saveTimeoutRef.current = setTimeout(() => {
        if (pendingSaveRef.current) {
          void doSaveClassification(pendingSaveRef.current.holdId, pendingSaveRef.current.classification);
          pendingSaveRef.current = null;
        }
      }, 500);
    },
    [doSaveClassification],
  );

  // Flush pending save immediately (e.g., when navigating)
  const flushPendingSave = useCallback(() => {
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
      saveTimeoutRef.current = null;
    }
    if (pendingSaveRef.current) {
      void doSaveClassification(pendingSaveRef.current.holdId, pendingSaveRef.current.classification);
      pendingSaveRef.current = null;
    }
  }, [doSaveClassification]);

  const getCurrentClassification = useCallback((): HoldClassification => {
    if (!currentHold) {
      return { holdId: 0, holdType: null, handRating: null, footRating: null, pullDirection: null };
    }
    return (
      classifications.get(currentHold.id) || {
        holdId: currentHold.id,
        holdType: null,
        handRating: null,
        footRating: null,
        pullDirection: null,
      }
    );
  }, [currentHold, classifications]);

  const handleHoldTypeSelect = useCallback(
    (holdType: HoldType) => {
      if (!currentHold) return;

      const current = getCurrentClassification();
      const updated: HoldClassification = {
        ...current,
        holdId: currentHold.id,
        holdType,
      };

      setClassifications(new Map(classifications).set(currentHold.id, updated));
      saveClassification(currentHold.id, updated);
    },
    [currentHold, classifications, getCurrentClassification, saveClassification],
  );

  const handleHandRatingChange = useCallback(
    (rating: number) => {
      if (!currentHold) return;

      const current = getCurrentClassification();
      const updated: HoldClassification = {
        ...current,
        holdId: currentHold.id,
        handRating: rating,
      };

      setClassifications(new Map(classifications).set(currentHold.id, updated));
      saveClassification(currentHold.id, updated);
    },
    [currentHold, classifications, getCurrentClassification, saveClassification],
  );

  const handleFootRatingChange = useCallback(
    (rating: number) => {
      if (!currentHold) return;

      const current = getCurrentClassification();
      const updated: HoldClassification = {
        ...current,
        holdId: currentHold.id,
        footRating: rating,
      };

      setClassifications(new Map(classifications).set(currentHold.id, updated));
      saveClassification(currentHold.id, updated);
    },
    [currentHold, classifications, getCurrentClassification, saveClassification],
  );

  const handlePullDirectionChange = useCallback(
    (direction: number) => {
      if (!currentHold) return;

      const current = getCurrentClassification();
      const updated: HoldClassification = {
        ...current,
        holdId: currentHold.id,
        pullDirection: direction,
      };

      setClassifications(new Map(classifications).set(currentHold.id, updated));
      saveClassification(currentHold.id, updated);
    },
    [currentHold, classifications, getCurrentClassification, saveClassification],
  );

  const handlePrevious = useCallback(() => {
    if (currentIndex > 0) {
      flushPendingSave();
      setCurrentIndex(currentIndex - 1);
      setIsComplete(false);
    }
  }, [currentIndex, flushPendingSave]);

  const handleNext = useCallback(() => {
    flushPendingSave();
    if (currentIndex < holds.length - 1) {
      setCurrentIndex(currentIndex + 1);
    } else {
      setIsComplete(true);
      onComplete?.();
    }
  }, [currentIndex, holds.length, onComplete, flushPendingSave]);

  const progress = holds.length > 0 ? ((currentIndex + 1) / holds.length) * 100 : 0;
  const classifiedCount = Array.from(classifications.values()).filter(
    (c) => c.holdType !== null || c.handRating !== null || c.footRating !== null || c.pullDirection !== null,
  ).length;

  // Filter hold types based on board type (e.g., exclude pocket for Kilter)
  const filteredHoldTypeOptions = useMemo(() => {
    const boardName = boardDetails.board_name as string;
    return HOLD_TYPE_OPTIONS.filter((option) => {
      return !(option.excludeBoards as readonly string[]).includes(boardName);
    });
  }, [boardDetails.board_name]);

  // Render loading state
  if (loading) {
    return (
      <SwipeableDrawer
        title={t('holdClassification.drawerTitle')}
        open={open}
        onClose={onClose}
        placement="bottom"
        fullHeight
        styles={{
          wrapper: { height: '100dvh' },
          header: { paddingTop: `max(16px, ${themeTokens.layout.safeAreaTop})` },
        }}
      >
        <div className={styles.loadingContainer}>
          <CircularProgress size={48} />
          <Typography variant="body2" component="span" className={styles.loadingText}>
            {t('holdClassification.loadingHolds')}
          </Typography>
        </div>
      </SwipeableDrawer>
    );
  }

  // Render empty state
  if (holds.length === 0) {
    return (
      <SwipeableDrawer
        title={t('holdClassification.drawerTitle')}
        open={open}
        onClose={onClose}
        placement="bottom"
        fullHeight
        styles={{
          wrapper: { height: '100dvh' },
          header: { paddingTop: `max(16px, ${themeTokens.layout.safeAreaTop})` },
        }}
      >
        <div className={styles.emptyState}>
          <Typography variant="body2" component="span">
            {t('holdClassification.emptyState')}
          </Typography>
          <MuiButton variant="outlined" onClick={onClose}>
            {t('common:actions.close')}
          </MuiButton>
        </div>
      </SwipeableDrawer>
    );
  }

  // Render completion state
  if (isComplete) {
    return (
      <SwipeableDrawer
        title={t('holdClassification.drawerTitle')}
        open={open}
        onClose={onClose}
        placement="bottom"
        fullHeight
        styles={{
          wrapper: { height: '100dvh' },
          header: { paddingTop: `max(16px, ${themeTokens.layout.safeAreaTop})` },
        }}
      >
        <div className={styles.completeContainer}>
          <CheckCircle className={styles.completeIcon} />
          <Typography variant="h5" component="h3" className={styles.completeTitle}>
            {t('holdClassification.complete.title')}
          </Typography>
          <Typography variant="body2" component="span" className={styles.completeSubtitle}>
            {t('holdClassification.complete.subtitle', { classified: classifiedCount, total: holds.length })}
          </Typography>
          <MuiButton variant="contained" size="large" onClick={onClose}>
            {t('common:actions.done')}
          </MuiButton>
        </div>
      </SwipeableDrawer>
    );
  }

  const currentClassification = getCurrentClassification();

  return (
    <SwipeableDrawer
      title={t('holdClassification.classifyHoldTitle')}
      open={open}
      onClose={onClose}
      placement="bottom"
      fullHeight
      styles={{
        wrapper: { height: '100dvh' },
        header: {
          borderBottom: '1px solid var(--neutral-200)',
          paddingTop: `max(16px, ${themeTokens.layout.safeAreaTop})`,
        },
        body: {
          padding: 16,
          overflow: 'auto',
        },
      }}
    >
      <div className={styles.container}>
        {/* Progress indicator */}
        <div className={styles.progressSection}>
          <Typography variant="body2" component="span" className={styles.progressText}>
            {t('holdClassification.progress', {
              current: currentIndex + 1,
              total: holds.length,
              classified: classifiedCount,
            })}
          </Typography>
          <LinearProgress
            variant="determinate"
            value={progress}
            sx={{ '& .MuiLinearProgress-bar': { backgroundColor: 'var(--color-primary-fill)' } }}
          />
        </div>

        {/* Hold view (zoomed in on the board) */}
        <div className={`${styles.holdViewSection} ${isHoldViewExpanded ? styles.holdViewExpanded : ''}`}>
          <div className={styles.holdViewContainer}>
            {currentHold && <HoldView hold={currentHold} boardDetails={boardDetails} expanded={isHoldViewExpanded} />}
          </div>
          <MuiButton
            className={styles.expandButton}
            variant="text"
            size="small"
            startIcon={isHoldViewExpanded ? <CompressOutlined /> : <OpenInFullOutlined />}
            onClick={() => setIsHoldViewExpanded(!isHoldViewExpanded)}
          >
            {isHoldViewExpanded ? 'Collapse' : 'Show full board'}
          </MuiButton>
        </div>

        {/* Classification controls */}
        <div className={styles.classificationSection}>
          {/* Hold type selection */}
          <div>
            <Typography variant="body2" component="span" className={styles.sectionTitle}>
              {t('holdClassification.fields.holdType')}
            </Typography>
            <div className={styles.holdTypeList}>
              {filteredHoldTypeOptions.map((option) => (
                <div
                  key={option.value}
                  className={`${styles.holdTypeItem} ${
                    currentClassification.holdType === option.value ? styles.holdTypeItemSelected : ''
                  }`}
                  onClick={() => handleHoldTypeSelect(option.value)}
                >
                  <span className={styles.holdTypeLabel}>{option.label}</span>
                  {currentClassification.holdType === option.value && (
                    <CheckOutlined className={styles.holdTypeCheck} />
                  )}
                </div>
              ))}
            </div>
          </div>

          {/* Hand rating */}
          <div className={styles.ratingSection}>
            <Typography variant="body2" component="span" className={styles.sectionTitle}>
              {t('holdClassification.fields.handRating')}
            </Typography>
            <div className={styles.ratingLabel}>{t('holdClassification.hints.handRating')}</div>
            <Rating
              value={currentClassification.handRating || 0}
              onChange={(_, val) => val !== null && handleHandRatingChange(val)}
              readOnly={saving}
            />
          </div>

          {/* Foot rating */}
          <div className={styles.ratingSection}>
            <Typography variant="body2" component="span" className={styles.sectionTitle}>
              {t('holdClassification.fields.footRating')}
            </Typography>
            <div className={styles.ratingLabel}>{t('holdClassification.hints.footRating')}</div>
            <Rating
              value={currentClassification.footRating || 0}
              onChange={(_, val) => val !== null && handleFootRatingChange(val)}
              readOnly={saving}
            />
          </div>

          {/* Direction of pull */}
          <div className={styles.directionSection}>
            <Typography variant="body2" component="span" className={styles.sectionTitle}>
              {t('holdClassification.fields.pullDirection')}
            </Typography>
            <div className={styles.ratingLabel}>{t('holdClassification.hints.pullDirection')}</div>
            <DirectionPicker
              value={currentClassification.pullDirection}
              onChange={handlePullDirectionChange}
              disabled={saving}
            />
          </div>
        </div>

        {/* Navigation buttons */}
        <div className={styles.navigationSection}>
          <MuiButton
            className={styles.navButton}
            variant="outlined"
            startIcon={<ArrowBackOutlined />}
            onClick={handlePrevious}
            disabled={currentIndex === 0 || saving}
          >
            {t('holdClassification.actions.previous')}
          </MuiButton>
          <MuiButton className={styles.skipButton} variant="outlined" onClick={handleNext} disabled={saving}>
            {t('holdClassification.actions.skip')}
          </MuiButton>
          <MuiButton
            className={styles.navButton}
            variant="contained"
            startIcon={<ArrowForwardOutlined />}
            onClick={handleNext}
            disabled={saving}
          >
            {currentIndex === holds.length - 1 ? t('holdClassification.actions.finish') : t('common:actions.next')}
          </MuiButton>
        </div>
      </div>
    </SwipeableDrawer>
  );
};

export default HoldClassificationWizard;
