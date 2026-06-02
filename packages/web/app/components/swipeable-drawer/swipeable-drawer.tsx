'use client';

import React, { useMemo, useCallback, useRef, useEffect, useLayoutEffect } from 'react';
import { useTranslation } from 'react-i18next';
import MuiSwipeableDrawer from '@mui/material/SwipeableDrawer';
import Box from '@mui/material/Box';
import IconButton from '@mui/material/IconButton';
import Typography from '@mui/material/Typography';
import CloseOutlined from '@mui/icons-material/CloseOutlined';
import { themeTokens } from '@/app/theme/theme-config';
import { onTransformSettled } from '@/app/lib/hooks/pull-to-close';
import styles from './swipeable-drawer.module.css';

// Runs before paint in the browser; degrades to useEffect during SSR so it
// doesn't warn. We need the pre-paint variant so the paper can be hidden in the
// same frame React `open` flips (see the gesture-close opacity guard below).
const useIsomorphicLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect;

type Placement = 'left' | 'right' | 'top' | 'bottom';

// When a swipe/pull gesture has already slid the paper off-screen, the MUI Slide
// EXIT must be instant (0ms) so it doesn't re-animate the paper from the open
// position. `enter` keeps MUI's default entering-screen duration so opening is
// unaffected; only the exit is collapsed.
const GESTURE_EXIT_TRANSITION = { appear: 0, enter: 225, exit: 0 } as const;

/**
 * Read the element's current on-screen translate offset (px) along the swipe
 * axis from its COMPUTED transform matrix, falling back to parsing the inline
 * transform when `DOMMatrix`/`getComputedStyle` are unavailable (jsdom). Reading
 * the computed matrix is resilient to the inline transform being written in a
 * different syntax (`translate(0, Ypx)` vs `translateY(Ypx)`) or cleared by a
 * competing transition.
 */
function readCurrentTranslate(el: HTMLElement, horizontal: boolean): number {
  if (typeof window !== 'undefined' && typeof window.getComputedStyle === 'function') {
    const computed = window.getComputedStyle(el).transform;
    if (computed && computed !== 'none' && typeof DOMMatrix !== 'undefined') {
      try {
        const matrix = new DOMMatrix(computed);
        return horizontal ? matrix.m41 : matrix.m42;
      } catch {
        // Fall through to inline parsing below.
      }
    }
  }
  const inline = el.style.transform;
  const pair = inline.match(/translate(?:3d)?\(\s*(-?[\d.]+)px\s*,\s*(-?[\d.]+)px/);
  if (pair) return parseFloat(horizontal ? pair[1] : pair[2]);
  const single = inline.match(/translate([XY])\(\s*(-?[\d.]+)px/);
  if (single && ((horizontal && single[1] === 'X') || (!horizontal && single[1] === 'Y'))) {
    return parseFloat(single[2]);
  }
  return 0;
}

export type SwipeableDrawerProps = {
  swipeEnabled?: boolean;
  showDragHandle?: boolean;
  // Drawer props
  open?: boolean;
  onClose?: (e?: React.MouseEvent | React.KeyboardEvent) => void;
  placement?: Placement;
  title?: React.ReactNode;
  showCloseButton?: boolean;
  showCloseButtonOnMobile?: boolean;
  disableBackdropClick?: boolean;
  onTransitionEnd?: (open: boolean) => void;
  styles?: {
    wrapper?: React.CSSProperties;
    body?: React.CSSProperties;
    header?: React.CSSProperties;
    footer?: React.CSSProperties;
    mask?: React.CSSProperties;
  };
  rootClassName?: string;
  className?: string;
  height?: string | number;
  width?: string | number;
  /** Explicitly mark the drawer as full-height for styling (e.g. page-like background). */
  fullHeight?: boolean;
  extra?: React.ReactNode;
  footer?: React.ReactNode;
  disablePortal?: boolean;
  keepMounted?: boolean;
  /** Ref forwarded to the MUI Paper element inside the drawer. */
  paperRef?: React.Ref<HTMLDivElement>;
  /**
   * When true, the MUI Slide transition skips the enter animation on the
   * drawer's very first paint (after that, normal open/close transitions
   * resume). Use for drawers that should appear already-open on a route's
   * first render — e.g. the play view on a direct hit to /view/{uuid}.
   */
  disableEnterAnimation?: boolean;
  children?: React.ReactNode;
};

const SwipeableDrawer: React.FC<SwipeableDrawerProps> = ({
  swipeEnabled,
  showDragHandle = true,
  placement = 'bottom',
  showCloseButton,
  showCloseButtonOnMobile = false,
  onClose,
  onTransitionEnd: userOnTransitionEnd,
  styles: userStyles,
  rootClassName: userRootClassName,
  className,
  title: userTitle,
  height,
  width,
  fullHeight: fullHeightProp,
  extra,
  footer,
  disablePortal,
  keepMounted = false,
  paperRef,
  disableBackdropClick,
  disableEnterAnimation = false,
  open,
  children,
}) => {
  const { t } = useTranslation('common');
  // If swipeEnabled is explicitly passed, use it directly.
  // Otherwise, disable swipe when showCloseButton is explicitly false.
  const effectiveSwipeEnabled = swipeEnabled ?? showCloseButton !== false;

  // `rootClassName` and `className` are accepted as aliases and are not meant
  // to be merged — prefer `rootClassName`, fall back to `className`. When
  // the consumer opts out via `showCloseButtonOnMobile`, we skip applying
  // the `mobileHideClose` CSS module class that otherwise hides the close
  // button on viewports <768px.
  const userClasses = userRootClassName ?? className;
  const rootClassName = [showCloseButtonOnMobile ? null : styles.mobileHideClose, userClasses]
    .filter(Boolean)
    .join(' ');

  const horizontalDragHandle = useMemo(
    () =>
      showDragHandle ? (
        <div className={styles.dragHandleZoneHorizontal}>
          <div className={styles.dragHandleBarHorizontal} />
        </div>
      ) : null,
    [showDragHandle],
  );

  const verticalDragHandle = useMemo(
    () =>
      effectiveSwipeEnabled && showDragHandle ? (
        <div className={placement === 'left' ? styles.dragHandleZoneRight : styles.dragHandleZoneLeft} />
      ) : null,
    [effectiveSwipeEnabled, showDragHandle, placement],
  );

  // For bottom placement with a title:
  // Inject the drag handle into the title so it appears above the header content.
  const handleInHeader = placement === 'bottom' && userTitle !== undefined && userTitle !== null;

  // For top-placed drawers, render drag handle below footer (at the bottom edge)
  const hasExternalBottomHandle = placement === 'top' && showDragHandle;

  // Build the header element if title is provided
  const headerElement = useMemo(() => {
    if (userTitle === undefined || userTitle === null) {
      return null;
    }

    const titleContent = (
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: `${themeTokens.spacing[4]}px ${themeTokens.spacing[6]}px`,
          borderBottom: '1px solid var(--neutral-200)',
          ...userStyles?.header,
        }}
      >
        <Typography
          variant="h6"
          component="div"
          sx={{
            flex: 1,
            minWidth: 0,
            fontWeight: themeTokens.typography.fontWeight.semibold,
            fontSize: themeTokens.typography.fontSize.base,
          }}
        >
          {userTitle}
        </Typography>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>{extra}</Box>
      </Box>
    );

    if (!handleInHeader) return titleContent;

    if (placement === 'bottom') {
      return (
        <div className={styles.titleWithHandle}>
          {horizontalDragHandle}
          {titleContent}
        </div>
      );
    }
    // placement === 'top': handle below title
    return (
      <div className={styles.titleWithHandle}>
        {titleContent}
        {horizontalDragHandle}
      </div>
    );
  }, [userTitle, extra, placement, handleInHeader, horizontalDragHandle, userStyles?.header]);

  const closeButton = useMemo(() => {
    if (showCloseButton === false) return null;

    const positionMap: Record<Placement, Record<string, number | string>> = {
      bottom: { top: 8, left: 8 },
      top: { top: 8, right: 8 },
      left: { top: 8, right: 8 },
      right: { top: 8, left: 8 },
    };

    return (
      <IconButton
        className="drawer-close-btn"
        size="small"
        onClick={(e) => onClose?.(e)}
        aria-label={t('ariaLabels.close')}
        sx={{
          position: 'absolute',
          zIndex: 2,
          ...positionMap[placement],
          color: 'text.primary',
          backgroundColor: 'action.selected',
          '&:hover': { backgroundColor: 'action.focus' },
        }}
      >
        <CloseOutlined />
      </IconButton>
    );
  }, [showCloseButton, placement, onClose, t]);

  // Drag handles for top/bottom placements are rendered OUTSIDE the scrollable
  // body Box so MUI's getDomTreeShapes doesn't find a scroll container between
  // the drag handle and the Paper, which would block swipe-to-close gestures.
  // Left/right vertical handles use position:absolute and stay inside.
  const topDragHandle = useMemo(() => {
    if (handleInHeader || !showDragHandle) return null;
    if (placement === 'bottom') return horizontalDragHandle;
    return null;
  }, [handleInHeader, showDragHandle, placement, horizontalDragHandle]);

  const bottomDragHandle = useMemo(() => {
    if (handleInHeader || !showDragHandle || hasExternalBottomHandle) return null;
    if (placement === 'top') return horizontalDragHandle;
    return null;
  }, [handleInHeader, showDragHandle, hasExternalBottomHandle, placement, horizontalDragHandle]);

  const wrappedChildren = useMemo(() => {
    if (handleInHeader) {
      return children;
    }

    // Only left/right placements keep drag handles inside the body (absolute positioned)
    return (
      <>
        {placement === 'left' && verticalDragHandle}
        {children}
        {placement === 'right' && verticalDragHandle}
      </>
    );
  }, [placement, verticalDragHandle, handleInHeader, children]);

  // Compute paper dimensions from height/width/styles.wrapper
  const paperSx = useMemo(() => {
    const sx: Record<string, unknown> = {};

    // Apply wrapper styles (styles.wrapper → MUI PaperProps.sx)
    if (userStyles?.wrapper) {
      Object.assign(sx, userStyles.wrapper);
    }

    // height/width props take precedence if not already set
    if (height && !sx.height) {
      sx.height = height;
    }
    if (width && !sx.width) {
      sx.width = width;
    }

    // Full-height drawers should blend into the app/page background.
    // Prefer the explicit fullHeight prop. The string-based fallback below is
    // best-effort for callers that haven't adopted the prop yet — it only
    // matches exact '100%' / '100vh' / '100dvh' values, not expressions like
    // calc(100vh) or custom-property references. New callers should always
    // pass fullHeight explicitly.
    const normalizedHeight = typeof sx.height === 'string' ? sx.height.trim().toLowerCase() : '';
    const isFullHeightDrawer =
      fullHeightProp ?? (normalizedHeight === '100%' || normalizedHeight === '100vh' || normalizedHeight === '100dvh');
    if (isFullHeightDrawer && !sx.backgroundColor) {
      sx.backgroundColor = 'var(--semantic-background)';
    }

    // Full-height bottom drawers extend to the top of the screen and need
    // safe-area-inset-top padding to avoid rendering behind the device notch/pill.
    // (Top/left/right anchors get this from the MUI theme overrides.)
    if (isFullHeightDrawer && placement === 'bottom' && !sx.paddingTop) {
      sx.paddingTop = themeTokens.layout.safeAreaTop;
    }

    return sx;
  }, [userStyles?.wrapper, height, width, fullHeightProp, placement]);

  // SwipeableDrawer onClose handler.
  // When triggered by a swipe fling, the Paper is at an intermediate position
  // with an inline transform from MUI's setPosition (no transition). We finish
  // the slide off-screen ourselves and flip React `open` only AFTER the paper is
  // off-screen, so MUI's Slide exit (which runs on the `open=false` flip) starts
  // from the already-off-screen position and is a visual no-op. Two details make
  // the hand-off seamless and stop the paper snapping back toward open:
  //   1. We target the SAME distance Slide's exit uses (viewport-relative) and
  //      emit it in Slide's single-axis `translateY(...)`/`translateX(...)`
  //      syntax, so the browser never has to interpolate between mismatched
  //      transform-function lists.
  //   2. We leave the inline transform pinned at the target and fire onClose on
  //      `transitionend` (timer fallback), so there's no timer-vs-transition race.
  // We intentionally leave MUI's hysteresis/minFlingVelocity at their defaults:
  // their abort branch only runs when MUI decides NOT to close (it resets the
  // paper to open without calling onClose), which is not this path.
  // Tracks the MUI Paper element (set by the wrapper Box's callback ref below).
  const lastPaperRef = useRef<HTMLDivElement | null>(null);
  const closeSettleCleanupRef = useRef<(() => void) | null>(null);
  useEffect(() => () => closeSettleCleanupRef.current?.(), []);
  const handleSwipeableClose = useCallback(() => {
    const paper = lastPaperRef.current;
    // Only a swipe leaves an inline transform on the paper. Backdrop click, Esc,
    // and programmatic closes have none — close synchronously as before.
    if (paper && paper.style.transform) {
      const isHorizontal = placement === 'left' || placement === 'right';
      // Off-screen target = the paper's layout size along the swipe axis, which
      // equals MUI Slide's exit distance for an edge-anchored drawer. Use
      // offsetWidth/offsetHeight (NOT getBoundingClientRect, which already
      // includes the live swipe transform) and emit Slide's single-axis syntax.
      const maxTranslate = isHorizontal ? paper.offsetWidth : paper.offsetHeight;
      const sign = placement === 'right' || placement === 'bottom' ? 1 : -1;
      const target = isHorizontal ? `translateX(${sign * maxTranslate}px)` : `translateY(${sign * maxTranslate}px)`;

      // Duration proportional to the remaining distance so the slide carries the
      // fling's momentum: a short fling from near the top has more distance left
      // → longer; a deep fling has less → snappier. Clamp to a sensible range.
      const currentTranslate = Math.abs(readCurrentTranslate(paper, isHorizontal));
      const remaining = Math.max(0, maxTranslate - currentTranslate);
      const fraction = maxTranslate > 0 ? remaining / maxTranslate : 1;
      const duration = Math.max(120, Math.min(300, fraction * 300));

      // Force reflow so the browser commits the current swipe position as the
      // transition start value. Without this, setting transition + transform in
      // the same microtask can cause browsers to skip the animation.
      void paper.offsetHeight;

      const ease = 'cubic-bezier(0.0, 0, 0.2, 1)'; // decelerate — momentum feel
      paper.style.transition = `transform ${duration}ms ${ease}`;
      paper.style.webkitTransition = `-webkit-transform ${duration}ms ${ease}`;
      paper.style.transform = target;
      paper.style.webkitTransform = target;

      closeSettleCleanupRef.current?.();
      closeSettleCleanupRef.current = onTransformSettled(paper, duration + 60, () => {
        closeSettleCleanupRef.current = null;
        onClose?.();
      });
      return;
    }
    onClose?.();
  }, [onClose, placement]);

  // Callback that controls whether swipe gestures are recognized.
  // Also prevents a parent drawer from capturing swipes that originate
  // inside a nested SwipeableDrawer (identified via data attribute on Paper)
  // or inside a zone marked with data-swipe-blocked (e.g. zoomed board).
  const allowSwipeInChildren = useCallback(
    (e: TouchEvent, _swipeArea: HTMLDivElement, paper: HTMLDivElement) => {
      if (!effectiveSwipeEnabled) return false;

      const target = e.target as HTMLElement | null;
      if (target) {
        const closestDrawerPaper = target.closest('[data-swipeable-drawer]');
        // If the closest drawer paper is a *nested* drawer (not this one),
        // don't let this (parent) drawer handle the swipe.
        if (closestDrawerPaper && closestDrawerPaper !== paper) {
          return false;
        }

        // Block swipe if it originates inside a swipe-blocked zone
        if (target.closest('[data-swipe-blocked]')) {
          return false;
        }
      }

      return true;
    },
    [effectiveSwipeEnabled],
  );

  // No-op onOpen handler — we manage open state externally
  const handleOpen = useCallback(() => {
    // Intentionally empty: opening is controlled by parent state
  }, []);

  // `appear` controls only the very first mount transition. When set false
  // and the drawer mounts already-open, MUI skips the slide-in animation.
  // After mount the prop has no effect, so subsequent open/close cycles
  // animate normally without any extra bookkeeping.
  // If the paper is already animated off-screen by a swipe/pull gesture (its
  // inline transform is translated past the half-way point) and React `open`
  // then flips to false, MUI's Slide exit would re-animate the paper from the
  // fully-OPEN position — the janky "snap back up, then close". Detect that
  // pre-positioned state and make the Slide EXIT instant: the gesture already
  // performed the visible slide, so the exit only needs to unmount the paper. A
  // normal button / Esc / backdrop close leaves no inline transform, so it keeps
  // MUI's default animated exit.
  //
  // We set the instant exit via BOTH `transitionDuration` and `SlideProps.timeout`.
  // For a fling, MUI uses an internally-computed `calculatedDurationRef` that
  // overrides `transitionDuration`, but `SlideProps.timeout` is merged onto the
  // transition slot last, so it wins and the exit stays instant on every path.
  //
  // NOTE: this reads DOM geometry (`getComputedStyle` / `offsetWidth` via
  // `readCurrentTranslate`) during render. It's a synchronous read of a ref we
  // own and only gates the exit duration, so a torn value just falls back to the
  // animated exit (no correctness impact) — but if this component is ever used
  // under React concurrent features, move it into a layout effect / event
  // handler to avoid reading layout in render.
  const exitPaper = lastPaperRef.current;
  const exitIsHorizontal = placement === 'left' || placement === 'right';
  const gesturePrePositioned =
    !!exitPaper &&
    Math.abs(readCurrentTranslate(exitPaper, exitIsHorizontal)) >
      (exitIsHorizontal ? exitPaper.offsetWidth : exitPaper.offsetHeight) * 0.5;

  // Hide the paper the instant `open` flips false on a gesture close. The gesture
  // has already slid it fully off-screen, so making it invisible is itself
  // invisible — but it means MUI's Slide exit (which clears + re-measures the
  // transform and, on iOS WebKit, can paint a single frame at the OPEN position)
  // can no longer flash the paper back on screen. That stray frame is the "snaps
  // back up" the exit-duration tweaks alone don't catch on Safari. The opacity is
  // restored below when `open` returns true (and the play-view open effect
  // separately clears the leftover transform).
  useIsomorphicLayoutEffect(() => {
    const paper = lastPaperRef.current;
    if (!paper) return;
    if (!(open ?? false) && gesturePrePositioned) {
      paper.style.opacity = '0';
    } else if (open ?? false) {
      paper.style.opacity = '';
    }
  }, [open, gesturePrePositioned]);

  const slideProps = useMemo(
    () => ({
      onExited: () => userOnTransitionEnd?.(false),
      onEntered: () => userOnTransitionEnd?.(true),
      appear: !disableEnterAnimation,
      ...(gesturePrePositioned ? { timeout: GESTURE_EXIT_TRANSITION } : {}),
    }),
    [userOnTransitionEnd, disableEnterAnimation, gesturePrePositioned],
  );

  const handleBackdropClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
  }, []);

  const slotProps = useMemo(
    () => ({
      backdrop: {
        ...(userStyles?.mask ? { style: userStyles.mask } : {}),
        ...(disableBackdropClick ? { onClick: handleBackdropClick } : {}),
      },
    }),
    [userStyles?.mask, disableBackdropClick, handleBackdropClick],
  );

  // IMPORTANT: Never pass `ref` in PaperProps. In MUI v7, mergeSlotProps does
  // { ...defaults, ...external } — a PaperProps.ref (even undefined) overwrites
  // MUI's internal handleRef, breaking swipe-to-close. We forward paperRef
  // through the wrapper Box's callback ref instead.
  const muiPaperProps = useMemo(() => ({ sx: paperSx, 'data-swipeable-drawer': 'true' }), [paperSx]);

  // Prevent MUI SwipeableDrawer from claiming touches that belong to the
  // drawer's inner content. We set `defaultMuiPrevented` on the native event
  // before MUI's document-level touchstart listener fires — React synthetic
  // handlers dispatch from the React root during bubbling, which beats
  // document listeners. Two cases:
  //
  // 1. Nested drawers (disablePortal + open): the parent drawer's document
  //    listener would otherwise claim every touch inside the child.
  //
  // 2. Any open drawer with a touch starting inside `[data-swipe-blocked]`:
  //    the attribute is also checked in `allowSwipeInChildren`, but that
  //    callback is only consulted when the drawer is closed (MUI v7 gates
  //    it behind `if (!open)`), so we need this second path to actually
  //    block swipe-to-close from map/zoom/drag-handle zones.
  const handleNestedTouchStart = useCallback(
    (e: React.TouchEvent) => {
      if (!(open ?? false)) return;
      const nativeEvent = e.nativeEvent as unknown as Record<string, unknown>;
      if (disablePortal) {
        nativeEvent.defaultMuiPrevented = true;
        return;
      }
      const target = e.target as Element | null;
      if (target?.closest('[data-swipe-blocked]')) {
        nativeEvent.defaultMuiPrevented = true;
      }
    },
    [disablePortal, open],
  );

  // Forward paperRef to the MUI Paper element via the wrapper Box's parent.
  const wrapperBoxRef = useCallback(
    (node: HTMLDivElement | null) => {
      // The wrapper Box's parentElement is the MUI Paper element
      const paper = node?.parentElement as HTMLDivElement | null;
      if (paper === lastPaperRef.current) return;
      lastPaperRef.current = paper;
      if (!paperRef) return;
      if (typeof paperRef === 'function') {
        paperRef(paper);
      } else {
        (paperRef as React.MutableRefObject<HTMLDivElement | null>).current = paper;
      }
    },
    [paperRef],
  );

  const transitionDuration = gesturePrePositioned ? GESTURE_EXIT_TRANSITION : undefined;

  const bodyContent = (
    <>
      {closeButton}
      {headerElement}
      {topDragHandle}
      <Box
        sx={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          minHeight: 0,
          overflow: 'auto',
          padding: `${themeTokens.spacing[6]}px`,
          ...userStyles?.body,
        }}
      >
        {wrappedChildren}
      </Box>
      {footer && (
        <Box
          sx={{
            padding: `${themeTokens.spacing[3]}px ${themeTokens.spacing[4]}px`,
            borderTop: '1px solid var(--neutral-200)',
            ...userStyles?.footer,
          }}
        >
          {footer}
        </Box>
      )}
      {bottomDragHandle}
      {hasExternalBottomHandle && horizontalDragHandle}
    </>
  );

  return (
    <MuiSwipeableDrawer
      anchor={placement}
      open={open ?? false}
      onClose={handleSwipeableClose}
      onOpen={handleOpen}
      className={rootClassName}
      disablePortal={disablePortal}
      keepMounted={keepMounted}
      disableSwipeToOpen
      disableDiscovery
      allowSwipeInChildren={allowSwipeInChildren}
      transitionDuration={transitionDuration}
      SlideProps={slideProps}
      slotProps={slotProps}
      PaperProps={muiPaperProps}
    >
      <Box
        ref={wrapperBoxRef}
        onTouchStart={handleNestedTouchStart}
        sx={{
          position: 'relative',
          display: 'flex',
          flexDirection: 'column',
          flex: 1,
          minHeight: 0,
        }}
      >
        {bodyContent}
      </Box>
    </MuiSwipeableDrawer>
  );
};

const MemoSwipeableDrawer = React.memo(SwipeableDrawer);
export default MemoSwipeableDrawer;
