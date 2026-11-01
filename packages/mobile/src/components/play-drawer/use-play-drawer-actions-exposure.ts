import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ComponentRef } from 'react';
import { AppState, View, type LayoutChangeEvent, type LayoutRectangle } from 'react-native';
import { SHARED_EVENTS } from '@boardsesh/analytics';
import { capture } from '../../lib/analytics';
import { getConsentSnapshot, subscribeConsent } from '../../lib/consent-state';
import type { PlayDrawerActionsContext } from '../../lib/play-drawer-actions-analytics';

/** Reuse the player's existing scroll callback; set React state only at row boundaries. */
export function usePlayDrawerActionsVisibility() {
  const viewportRef = useRef<ComponentRef<typeof View>>(null);
  const actionsRef = useRef<ComponentRef<typeof View>>(null);
  const measurementGeneration = useRef(0);
  const frames = useRef({
    offset: 0,
    viewportTop: 0,
    viewportBottom: 0,
    contentTop: 0,
    measured: false,
    primary: null as LayoutRectangle | null,
    secondary: null as LayoutRectangle | null,
  });
  const [visible, setVisible] = useState({ primary: false, secondary: false });
  const visibleRef = useRef(visible);
  const updateVisibility = useCallback(() => {
    const { measured, contentTop, offset, viewportTop, viewportBottom, primary, secondary } = frames.current;
    // Count a row only when it fits entirely inside the visible viewport. A
    // folded second row must never inflate Share's exposure denominator.
    const rowVisible = (frame: LayoutRectangle | null) => {
      if (!measured || !frame || frame.height <= 0) return false;
      const top = contentTop + frame.y - offset;
      return top >= viewportTop - 1 && top + frame.height <= viewportBottom + 1;
    };
    const next = { primary: rowVisible(primary), secondary: rowVisible(secondary) };
    if (next.primary === visibleRef.current.primary && next.secondary === visibleRef.current.secondary) return;
    visibleRef.current = next;
    setVisible(next);
  }, []);
  const measure = useCallback(() => {
    if (!viewportRef.current?.measureInWindow || !actionsRef.current?.measureInWindow) return;
    const generation = ++measurementGeneration.current;
    viewportRef.current.measureInWindow((_left, top, _width, height) => {
      if (generation !== measurementGeneration.current) return;
      frames.current.viewportTop = top;
      frames.current.viewportBottom = top + height;
      actionsRef.current?.measureInWindow((_actionsLeft, actionsTop) => {
        if (generation !== measurementGeneration.current) return;
        frames.current.contentTop = actionsTop + frames.current.offset;
        frames.current.measured = height > 0;
        updateVisibility();
      });
    });
  }, [updateVisibility]);
  const onScroll = useCallback(
    (offset: number) => {
      frames.current.offset = offset;
      updateVisibility();
    },
    [updateVisibility],
  );
  const onPrimaryLayout = useCallback(
    (event: LayoutChangeEvent) => {
      frames.current.primary = event.nativeEvent.layout;
      measure();
    },
    [measure],
  );
  const onSecondaryLayout = useCallback(
    (event: LayoutChangeEvent) => {
      frames.current.secondary = event.nativeEvent.layout;
      measure();
    },
    [measure],
  );
  return { viewportRef, actionsRef, visible, onScroll, onLayout: measure, onPrimaryLayout, onSecondaryLayout };
}

/** Once per visible climb/layout transition, never once per render or scroll frame. */
export function usePlayDrawerActionsExposure({
  context,
  climbUuid,
  boardName,
  layoutId,
  visible,
}: {
  context: PlayDrawerActionsContext;
  climbUuid: string | null;
  boardName: string;
  layoutId: number;
  visible: boolean;
}): void {
  const lastExposure = useRef<string | null>(null);
  const consent = useSyncExternalStore(subscribeConsent, getConsentSnapshot, getConsentSnapshot);
  const [foreground, setForeground] = useState(AppState.currentState === 'active');
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state !== 'active') lastExposure.current = null;
      setForeground(state === 'active');
    });
    return () => subscription.remove();
  }, []);
  const signature = JSON.stringify([climbUuid, boardName, layoutId, context]);
  useEffect(() => {
    if (!visible || !foreground || !climbUuid || context.player_visible_actions === '') return;
    if (lastExposure.current === signature) return;
    if (capture(SHARED_EVENTS.PlayDrawerActionsShown, { ...context, climbUuid, boardName, layoutId })) {
      lastExposure.current = signature;
    }
  }, [context, climbUuid, boardName, layoutId, visible, foreground, signature, consent]);
}
