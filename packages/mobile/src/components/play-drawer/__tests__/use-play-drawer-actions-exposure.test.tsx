// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import type { ComponentRef } from 'react';
import type { AppStateStatus, LayoutChangeEvent, View } from 'react-native';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const analytics = vi.hoisted(() => ({ capture: vi.fn(() => true) }));
const lifecycle = vi.hoisted(() => ({
  currentState: 'active' as AppStateStatus,
  appListeners: new Set<(state: AppStateStatus) => void>(),
  consent: { revision: 0 },
  consentListeners: new Set<() => void>(),
}));

vi.mock('react-native', () => ({
  View: class {},
  AppState: {
    get currentState() {
      return lifecycle.currentState;
    },
    addEventListener: (_event: string, listener: (state: AppStateStatus) => void) => {
      lifecycle.appListeners.add(listener);
      return { remove: () => lifecycle.appListeners.delete(listener) };
    },
  },
}));
vi.mock('@boardsesh/analytics', () => ({ SHARED_EVENTS: { PlayDrawerActionsShown: 'Play Drawer Actions Shown' } }));
vi.mock('../../../lib/analytics', () => ({ capture: analytics.capture }));
vi.mock('../../../lib/consent-state', () => ({
  getConsentSnapshot: () => lifecycle.consent,
  subscribeConsent: (listener: () => void) => {
    lifecycle.consentListeners.add(listener);
    return () => lifecycle.consentListeners.delete(listener);
  },
}));

import { DEFAULT_PLAYER_BUTTONS } from '../../../lib/player-buttons';
import { buildPlayDrawerActionsContext } from '../../../lib/play-drawer-actions-analytics';
import { resolveActionBarLayout } from '../action-bar-layout';
import { usePlayDrawerActionsExposure, usePlayDrawerActionsVisibility } from '../use-play-drawer-actions-exposure';

const layout = resolveActionBarLayout({
  supportsMirroring: true,
  isAnonymous: false,
  commitButton: null,
  workoutOutcome: false,
  showLightbulb: true,
  hasWall: true,
  hasShare: true,
  angleAvailable: true,
  buttons: DEFAULT_PLAYER_BUTTONS,
  previousNext: false,
});
const defaultContext = buildPlayDrawerActionsContext({
  layout,
  boardControl: 'wallButton',
  hasShare: true,
  wallControlVisible: true,
});
const defaultExposure = {
  context: defaultContext,
  climbUuid: 'climb-a',
  boardName: 'tension',
  layoutId: 11,
  visible: true,
};
type ExposureProps = Parameters<typeof usePlayDrawerActionsExposure>[0];

function rowLayout(y: number, height: number): LayoutChangeEvent {
  return { nativeEvent: { layout: { x: 0, y, width: 343, height } } } as LayoutChangeEvent;
}

function appState(state: AppStateStatus) {
  act(() => {
    lifecycle.currentState = state;
    for (const listener of lifecycle.appListeners) listener(state);
  });
}

function changeConsent() {
  act(() => {
    lifecycle.consent = { revision: lifecycle.consent.revision + 1 };
    for (const listener of lifecycle.consentListeners) listener();
  });
}

function renderMeasuredExposure() {
  return renderHook(() => {
    const measurement = usePlayDrawerActionsVisibility();
    usePlayDrawerActionsExposure({
      ...defaultExposure,
      context: buildPlayDrawerActionsContext({
        layout,
        boardControl: 'wallButton',
        hasShare: true,
        wallControlVisible: true,
        primaryVisible: measurement.visible.primary,
        secondaryVisible: measurement.visible.secondary,
      }),
      visible: measurement.visible.primary || measurement.visible.secondary,
    });
    return measurement;
  });
}

function attachMeasuredViews(
  measurement: ReturnType<typeof usePlayDrawerActionsVisibility>,
  frames = { viewportTop: 100, viewportHeight: 300, actionsTop: 300 },
) {
  const viewport = {
    measureInWindow: vi.fn((callback: (left: number, top: number, width: number, height: number) => void) => {
      callback(0, frames.viewportTop, 343, frames.viewportHeight);
    }),
  };
  const actions = {
    measureInWindow: vi.fn((callback: (left: number, top: number, width: number, height: number) => void) => {
      callback(0, frames.actionsTop, 343, 124);
    }),
  };
  measurement.viewportRef.current = viewport as unknown as ComponentRef<typeof View>;
  measurement.actionsRef.current = actions as unknown as ComponentRef<typeof View>;
  return { viewport, actions, frames };
}

beforeEach(() => {
  analytics.capture.mockReset().mockReturnValue(true);
  lifecycle.currentState = 'active';
  lifecycle.appListeners.clear();
  lifecycle.consentListeners.clear();
  lifecycle.consent = { revision: 0 };
});
afterEach(cleanup);

describe('play drawer action row visibility', () => {
  it('waits for native viewport and action measurements before sending an exposure', () => {
    const hook = renderMeasuredExposure();
    act(() => hook.result.current.onPrimaryLayout(rowLayout(0, 60)));
    expect(analytics.capture).not.toHaveBeenCalled();
    const { viewport } = attachMeasuredViews(hook.result.current);
    let completeViewportMeasurement: ((left: number, top: number, width: number, height: number) => void) | undefined;
    viewport.measureInWindow.mockImplementationOnce((callback) => {
      completeViewportMeasurement = callback;
    });
    act(() => hook.result.current.onLayout());
    expect(hook.result.current.visible).toEqual({ primary: false, secondary: false });
    expect(analytics.capture).not.toHaveBeenCalled();
    act(() => completeViewportMeasurement?.(0, 100, 343, 300));
    expect(hook.result.current.visible).toEqual({ primary: true, secondary: false });
    expect(analytics.capture).toHaveBeenCalledOnce();
    expect(analytics.capture).toHaveBeenLastCalledWith(
      'Play Drawer Actions Shown',
      expect.objectContaining({ player_tick_visible: true, player_share_visible: true }),
    );
  });

  it('keeps a partially folded secondary row out of the exposure context', () => {
    const hook = renderMeasuredExposure();
    attachMeasuredViews(hook.result.current);
    act(() => {
      hook.result.current.onPrimaryLayout(rowLayout(0, 60));
      hook.result.current.onSecondaryLayout(rowLayout(60, 64));
    });
    expect(hook.result.current.visible).toEqual({ primary: true, secondary: false });
    expect(analytics.capture).toHaveBeenCalledOnce();
    expect(analytics.capture).toHaveBeenLastCalledWith(
      'Play Drawer Actions Shown',
      expect.objectContaining({ player_visible_actions: 'mirror,favorite,tick,share,queue' }),
    );
    act(() => hook.result.current.onScroll(24));
    expect(hook.result.current.visible).toEqual({ primary: true, secondary: true });
    expect(analytics.capture).toHaveBeenLastCalledWith(
      'Play Drawer Actions Shown',
      expect.objectContaining({ player_visible_actions: 'mirror,favorite,tick,share,queue,wallControl' }),
    );
  });

  it('updates React state only when scrolling crosses a row visibility boundary', () => {
    const hook = renderHook(() => usePlayDrawerActionsVisibility());
    attachMeasuredViews(hook.result.current);
    act(() => {
      hook.result.current.onPrimaryLayout(rowLayout(0, 60));
      hook.result.current.onSecondaryLayout(rowLayout(60, 64));
    });
    const primaryOnly = hook.result.current.visible;
    act(() => hook.result.current.onScroll(1));
    act(() => hook.result.current.onScroll(10));
    expect(hook.result.current.visible).toBe(primaryOnly);
    act(() => hook.result.current.onScroll(24));
    const bothRows = hook.result.current.visible;
    expect(bothRows).toEqual({ primary: true, secondary: true });
    expect(bothRows).not.toBe(primaryOnly);
    act(() => hook.result.current.onScroll(25));
    act(() => hook.result.current.onScroll(30));
    expect(hook.result.current.visible).toBe(bothRows);
  });

  it('does not report rows above the viewport or a zero-height viewport', () => {
    const hook = renderMeasuredExposure();
    const { frames } = attachMeasuredViews(hook.result.current, {
      viewportTop: 100,
      viewportHeight: 300,
      actionsTop: 0,
    });
    act(() => {
      hook.result.current.onPrimaryLayout(rowLayout(0, 60));
      hook.result.current.onSecondaryLayout(rowLayout(60, 30));
    });
    expect(hook.result.current.visible).toEqual({ primary: false, secondary: false });
    expect(analytics.capture).not.toHaveBeenCalled();
    frames.actionsTop = 200;
    frames.viewportHeight = 0;
    act(() => hook.result.current.onLayout());
    expect(hook.result.current.visible).toEqual({ primary: false, secondary: false });
    expect(analytics.capture).not.toHaveBeenCalled();
  });
});

describe('play drawer action exposure capture', () => {
  it('deduplicates ordinary rerenders while sending new climbs and layouts', () => {
    const hook = renderHook((props: ExposureProps) => usePlayDrawerActionsExposure(props), {
      initialProps: defaultExposure,
    });
    hook.rerender({ ...defaultExposure, context: { ...defaultContext } });
    expect(analytics.capture).toHaveBeenCalledOnce();
    hook.rerender({ ...defaultExposure, climbUuid: 'climb-b' });
    expect(analytics.capture).toHaveBeenCalledTimes(2);
    hook.rerender({ ...defaultExposure, climbUuid: 'climb-b', layoutId: 12 });
    expect(analytics.capture).toHaveBeenCalledTimes(3);
    hook.rerender({
      ...defaultExposure,
      climbUuid: 'climb-b',
      context: { ...defaultContext, player_previous_next: true },
    });
    expect(analytics.capture).toHaveBeenCalledTimes(4);
  });

  it('waits until an occluded or MiniPlayer-delegated drawer becomes eligible', () => {
    const hook = renderHook((props: ExposureProps) => usePlayDrawerActionsExposure(props), {
      initialProps: { ...defaultExposure, visible: false },
    });
    expect(analytics.capture).not.toHaveBeenCalled();
    hook.rerender({ ...defaultExposure, climbUuid: 'climb-b', visible: false });
    expect(analytics.capture).not.toHaveBeenCalled();
    hook.rerender({ ...defaultExposure, climbUuid: 'climb-b' });
    expect(analytics.capture).toHaveBeenCalledOnce();
    expect(analytics.capture).toHaveBeenLastCalledWith(
      'Play Drawer Actions Shown',
      expect.objectContaining({ climbUuid: 'climb-b' }),
    );
  });

  it('does not capture absent climbs or an empty visible-action context', () => {
    const hook = renderHook((props: ExposureProps) => usePlayDrawerActionsExposure(props), {
      initialProps: { ...defaultExposure, climbUuid: null } as ExposureProps,
    });
    hook.rerender({ ...defaultExposure, context: { ...defaultContext, player_visible_actions: '' } });
    expect(analytics.capture).not.toHaveBeenCalled();
    hook.rerender(defaultExposure);
    expect(analytics.capture).toHaveBeenCalledOnce();
  });

  it('pauses captures in the background and counts a fresh foreground exposure', () => {
    const hook = renderHook((props: ExposureProps) => usePlayDrawerActionsExposure(props), {
      initialProps: defaultExposure,
    });
    expect(analytics.capture).toHaveBeenCalledOnce();
    appState('background');
    hook.rerender({ ...defaultExposure, climbUuid: 'climb-b' });
    expect(analytics.capture).toHaveBeenCalledOnce();
    appState('active');
    expect(analytics.capture).toHaveBeenCalledTimes(2);
    expect(analytics.capture).toHaveBeenLastCalledWith(
      'Play Drawer Actions Shown',
      expect.objectContaining({ climbUuid: 'climb-b' }),
    );
    appState('inactive');
    appState('active');
    expect(analytics.capture).toHaveBeenCalledTimes(3);
  });

  it('waits for the foreground when mounted while the app is backgrounded', () => {
    lifecycle.currentState = 'background';
    renderHook(() => usePlayDrawerActionsExposure(defaultExposure));
    expect(analytics.capture).not.toHaveBeenCalled();
    appState('active');
    expect(analytics.capture).toHaveBeenCalledOnce();
  });

  it('does not mark a consent-blocked capture sent and retries when consent changes', () => {
    analytics.capture.mockReturnValue(false);
    const hook = renderHook((props: ExposureProps) => usePlayDrawerActionsExposure(props), {
      initialProps: defaultExposure,
    });
    expect(analytics.capture).toHaveBeenCalledOnce();
    analytics.capture.mockReturnValue(true);
    changeConsent();
    expect(analytics.capture).toHaveBeenCalledTimes(2);
    changeConsent();
    hook.rerender({ ...defaultExposure, context: { ...defaultContext } });
    expect(analytics.capture).toHaveBeenCalledTimes(2);
  });

  it('removes AppState and consent subscriptions on unmount', () => {
    const hook = renderHook(() => usePlayDrawerActionsExposure(defaultExposure));
    expect(lifecycle.appListeners.size).toBe(1);
    expect(lifecycle.consentListeners.size).toBe(1);
    hook.unmount();
    expect(lifecycle.appListeners.size).toBe(0);
    expect(lifecycle.consentListeners.size).toBe(0);
  });
});
