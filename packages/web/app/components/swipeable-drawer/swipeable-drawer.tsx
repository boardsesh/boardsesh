'use client';

import React, { useMemo, useCallback, useRef } from 'react';
import MuiSwipeableDrawer from '@mui/material/SwipeableDrawer';
import Box from '@mui/material/Box';
import IconButton from '@mui/material/IconButton';
import Typography from '@mui/material/Typography';
import KeyboardArrowDownOutlined from '@mui/icons-material/KeyboardArrowDownOutlined';
import KeyboardArrowUpOutlined from '@mui/icons-material/KeyboardArrowUpOutlined';
import KeyboardArrowLeftOutlined from '@mui/icons-material/KeyboardArrowLeftOutlined';
import KeyboardArrowRightOutlined from '@mui/icons-material/KeyboardArrowRightOutlined';
import { themeTokens } from '@/app/theme/theme-config';
import styles from './swipeable-drawer.module.css';

type Placement = 'left' | 'right' | 'top' | 'bottom';

export interface SwipeableDrawerProps {
  swipeEnabled?: boolean;
  showDragHandle?: boolean;
  // Drawer props
  open?: boolean;
  onClose?: (e?: React.MouseEvent | React.KeyboardEvent) => void;
  placement?: Placement;
  title?: React.ReactNode;
  showCloseButton?: boolean;
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
  children?: React.ReactNode;
}

const SwipeableDrawer: React.FC<SwipeableDrawerProps> = ({
  swipeEnabled,
  showDragHandle = true,
  placement = 'bottom',
  showCloseButton,
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
  open,
  children,
}) => {
  // If swipeEnabled is explicitly passed, use it directly.
  // Otherwise, disable swipe when showCloseButton is explicitly false.
  const effectiveSwipeEnabled = swipeEnabled ?? (showCloseButton !== false);

  const rootClassName = userRootClassName
    ? `${styles.mobileHideClose} ${userRootClassName}`
    : className
      ? `${styles.mobileHideClose} ${className}`
      : styles.mobileHideClose;

  const isVerticalPlacement = placement === 'top' || placement === 'bottom';

  const horizontalDragHandle = useMemo(() => showDragHandle ? (
    <div className={styles.dragHandleZoneHorizontal}>
      <div className={styles.dragHandleBarHorizontal} />
    </div>
  ) : null, [showDragHandle]);

  const verticalDragHandle = useMemo(() => effectiveSwipeEnabled && showDragHandle ? (
    <div
      className={
        placement === 'left'
          ? styles.dragHandleZoneRight
          : styles.dragHandleZoneLeft
      }
    >
    </div>
  ) : null, [effectiveSwipeEnabled, showDragHandle, placement]);

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
          borderBottom: `1px solid ${themeTokens.neutral[200]}`,
          ...userStyles?.header,
        }}
      >
        <Typography variant="h6" component="div" sx={{ flex: 1, minWidth: 0, fontWeight: themeTokens.typography.fontWeight.semibold, fontSize: themeTokens.typography.fontSize.base }}>
          {userTitle}
        </Typography>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          {extra}
        </Box>
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

    const iconMap: Record<Placement, React.ReactElement> = {
      bottom: <KeyboardArrowDownOutlined />,
      top: <KeyboardArrowUpOutlined />,
      left: <KeyboardArrowLeftOutlined />,
      right: <KeyboardArrowRightOutlined />,
    };

    const positionMap: Record<Placement, Record<string, number | string>> = {
      bottom: { top: 8, left: 8 },
      top: { bottom: 8, left: 8 },
      left: { top: 8, right: 8 },
      right: { top: 8, left: 8 },
    };

    return (
      <IconButton
        className="drawer-close-btn"
        size="small"
        onClick={(e) => onClose?.(e)}
        sx={{
          position: 'absolute',
          zIndex: 2,
          ...positionMap[placement],
          backgroundColor: themeTokens.neutral[100],
          '&:hover': { backgroundColor: themeTokens.neutral[200] },
        }}
      >
        {iconMap[placement]}
      </IconButton>
    );
  }, [showCloseButton, placement, onClose]);

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
      fullHeightProp ??
      (normalizedHeight === '100%' || normalizedHeight === '100vh' || normalizedHeight === '100dvh');
    if (isFullHeightDrawer && !sx.backgroundColor) {
      sx.backgroundColor = 'var(--semantic-background)';
    }

    // Full-height bottom drawers extend to the top of the screen and need
    // safe-area-inset-top padding to avoid rendering behind the device notch/pill.
    // (Top/left/right anchors get this from the MUI theme overrides.)
    if (isFullHeightDrawer && placement === 'bottom' && !sx.paddingTop) {
      sx.paddingTop = 'env(safe-area-inset-top, 0px)';
    }

    return sx;
  }, [userStyles?.wrapper, height, width, fullHeightProp]);

  // SwipeableDrawer onClose handler.
  // When triggered by a swipe fling, the Paper is at an intermediate position
  // with inline styles from MUI's setPosition (translate(0, Xpx) format, no
  // transition). We animate it to off-screen ourselves using the SAME format,
  // then call onClose after the animation completes. This avoids the Slide
  // transition entirely for swipe-closes — Slide's format (translateY) can't
  // reliably interpolate with SwipeableDrawer's format in the same macrotask.
  const closeAnimRef = useRef<number>(0);
  const handleSwipeableClose = useCallback(() => {
    const paper = lastPaperRef.current;
    if (paper?.style.transform) {
      // Paper has inline transform from swipe — animate it off-screen ourselves.
      // We use the same translate() format MUI's setPosition uses so the browser
      // can interpolate between the current swipe position and the target.
      const isHorizontal = placement === 'left' || placement === 'right';
      const maxTranslate = isHorizontal ? paper.offsetWidth : paper.offsetHeight;
      const sign = placement === 'right' || placement === 'bottom' ? 1 : -1;
      const target = isHorizontal
        ? `translate(${sign * maxTranslate}px, 0)`
        : `translate(0, ${sign * maxTranslate}px)`;

      // Calculate duration proportional to remaining distance so the animation
      // feels like it carries the fling momentum. A short fling from near the
      // top has more distance → longer duration. A deep fling has less → snappier.
      const currentMatch = paper.style.transform.match(/translate\(\s*(.+?)px\s*,\s*(.+?)px\s*\)/);
      let currentTranslate = 0;
      if (currentMatch) {
        currentTranslate = Math.abs(parseFloat(isHorizontal ? currentMatch[1] : currentMatch[2]));
      }
      const remaining = maxTranslate - currentTranslate;
      const fraction = remaining / maxTranslate;
      // Base speed: cross the full distance in 300ms. Minimum 120ms so it doesn't
      // feel instant, maximum 300ms so it doesn't feel sluggish.
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

      // Call onClose after animation so React state update doesn't interfere
      clearTimeout(closeAnimRef.current);
      closeAnimRef.current = window.setTimeout(() => {
        onClose?.();
      }, duration + 10);
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

  const slideProps = useMemo(() => ({
    onExited: () => userOnTransitionEnd?.(false),
    onEntered: () => userOnTransitionEnd?.(true),
  }), [userOnTransitionEnd]);

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
  const muiPaperProps = useMemo(
    () => ({ sx: paperSx, 'data-swipeable-drawer': 'true' }),
    [paperSx],
  );

  // Forward paperRef to the MUI Paper element via the wrapper Box's parent.
  const lastPaperRef = useRef<HTMLDivElement | null>(null);
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
            borderTop: `1px solid ${themeTokens.neutral[200]}`,
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
      SlideProps={slideProps}
      slotProps={slotProps}
      PaperProps={muiPaperProps}
    >
      <Box ref={wrapperBoxRef} sx={{ position: 'relative', display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
        {bodyContent}
      </Box>
    </MuiSwipeableDrawer>
  );
};

export { SwipeableDrawer };
export default SwipeableDrawer;
