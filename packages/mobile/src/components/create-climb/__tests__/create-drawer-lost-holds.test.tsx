// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { createElement, forwardRef, useEffect, useImperativeHandle, type ReactNode } from 'react';

// A remix of a climb that lost holds: the drawer hands the board the grey rings
// as tap targets, and holds Save back with a line saying why until the climber
// has tapped every ring away. Harness shared with create-drawer-grade-prompt.

type LayoutEvent = { nativeEvent: { layout: { x: number; y: number; width: number; height: number } } };
type ViewMockProps = { children?: ReactNode; onLayout?: (event: LayoutEvent) => void; testID?: string };

/** Heights the two measured above-fold blocks report, keyed by testID. */
const MEASURED_HEIGHTS: Record<string, number> = {
  'create-drawer-measured-header': 60,
  'create-drawer-measured-board-block': 640,
};

vi.mock('react-native', () => ({
  View: ({ children, onLayout, testID }: ViewMockProps) => {
    // jsdom never lays out, so report the height the peek maths would measure.
    useEffect(() => {
      const height = testID ? MEASURED_HEIGHTS[testID] : undefined;
      if (onLayout && height !== undefined) onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 405, height } } });
    }, [onLayout, testID]);
    return createElement('div', { 'data-testid': testID }, children);
  },
  StyleSheet: { create: (styles: Record<string, unknown>) => styles, hairlineWidth: 1 },
  useWindowDimensions: () => ({ width: 405, height: 900 }),
}));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 24, bottom: 0 }) }));
vi.mock('../../../hooks/use-window-bottom-inset', () => ({ useWindowBottomInset: () => 48 }));

const sheet = vi.hoisted(() => ({ snapToIndex: vi.fn(), close: vi.fn() }));
const scroll = vi.hoisted(() => ({ scrollTo: vi.fn() }));
vi.mock('@expo/ui/community/bottom-sheet', () => ({
  default: forwardRef(function BottomSheetMock({ children }: { children?: ReactNode }, ref) {
    useImperativeHandle(ref, () => sheet);
    return createElement('div', null, children);
  }),
}));
vi.mock('react-native-gesture-handler', () => ({
  GestureHandlerRootView: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  ScrollView: forwardRef(function ScrollViewMock({ children }: { children?: ReactNode }, ref) {
    useImperativeHandle(ref, () => scroll);
    return createElement('div', null, children);
  }),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({ systemColors: { secondaryBackground: '#221A33' } }),
}));
vi.mock('../../../theme/tokens', () => ({
  spacing: { 1: 4, 2: 8, 3: 12, 4: 16, 6: 24 },
  sheetStyles: { background: {} },
}));
vi.mock('../../board/HeatmapOverlay', () => ({
  HeatmapOverlay: () => null,
  useHeatLayer: () => ({ cells: [], codeColors: {}, legend: { kind: 'count', edgeValues: [], total: 0 } }),
}));
vi.mock('../../board/HeatmapLegend', () => ({ HeatmapLegend: () => null }));
vi.mock('../../board/HeatmapDownloadLine', () => ({ HeatmapDownloadLine: () => null }));
const captured = vi.hoisted(() => ({
  board: null as null | Record<string, unknown>,
  actionBar: null as null | Record<string, unknown>,
}));
vi.mock('../InteractiveCreateBoard', () => ({
  InteractiveCreateBoard: (props: Record<string, unknown>) => {
    captured.board = props;
    return createElement('div', { 'data-node': 'board' });
  },
}));
vi.mock('../CreateDrawerHeader', () => ({
  CreateDrawerHeader: () => createElement('div', { 'data-node': 'header' }),
}));
vi.mock('../CreateDrawerActionBar', () => ({
  CreateDrawerActionBar: (props: Record<string, unknown>) => {
    captured.actionBar = props;
    return createElement('div', { 'data-node': 'action-bar' });
  },
}));
const formProps = vi.hoisted(() => ({ last: null as null | Record<string, unknown> }));
// The lost-hold ring layer draws through react-native-svg and has its own suite.
vi.mock('../LostHoldGhostLayer', () => ({ LostHoldGhostLayer: () => null }));
vi.mock('../CreateDrawerForm', () => ({
  CreateDrawerForm: (props: Record<string, unknown>) => {
    formProps.last = props;
    return createElement('div', { 'data-node': 'form' });
  },
}));
vi.mock('../OpenDraftsSection', () => ({ OpenDraftsSection: () => createElement('div', { 'data-node': 'drafts' }) }));
vi.mock('../InlineConfirmBanner', () => ({
  InlineConfirmBanner: () => createElement('div', { 'data-node': 'banner' }),
}));
vi.mock('../DuplicateBanner', () => ({ DuplicateBanner: () => createElement('div', { 'data-node': 'banner' }) }));
vi.mock('../CreateRoutePlaybackSlot', () => ({
  CreateRoutePlaybackSlot: () => createElement('div', { 'data-node': 'route-slot' }),
}));

import { CreateDrawer } from '../CreateDrawer';
import type { LostHoldGhostsState } from '../use-lost-hold-ghosts';

const board = { boardName: 'spray' as const, layoutId: 9001, sizeId: 9001, setIds: '1', angle: 25 };
const boardHolds = { holdTargets: [], boardWidth: 650, boardHeight: 1000 };

type Controller = Parameters<typeof CreateDrawer>[0]['controller'];

const controller = {
  name: 'Old blue remix',
  setName: vi.fn(),
  focusNameSignal: 0,
  litUpHoldsMap: {},
  frameCount: 1,
  currentFrameIndex: 0,
  blankClimbEpoch: 0,
  supportsMultiFrame: true,
  routeMode: false,
  showRouteTransport: false,
  playback: {},
  saveState: 'ready',
  handleSave: vi.fn(),
  publishBlocked: false,
  draftStatus: null,
  pendingNewClimb: false,
  publishDuplicateError: null,
  isDraft: false,
} as unknown as Controller;

function drawerWith(lostHolds: LostHoldGhostsState | undefined) {
  return createElement(CreateDrawer, {
    board,
    controller,
    boardHolds,
    onLongPressHold: vi.fn(),
    subSheetOpen: false,
    onLoadDraft: vi.fn(),
    onClose: vi.fn(),
    onViewDuplicate: vi.fn(),
    lostHolds,
  });
}

const ring = { id: 42, cx: 100, cy: 120, r: 10 };

describe('CreateDrawer with a remix that lost holds', () => {
  it('hands the board the rings, and holds Save back with a reason while any is up', () => {
    const dismissGhost = vi.fn();
    render(drawerWith({ ghosts: [ring], ghostTargets: [ring], dismissGhost }));

    expect(captured.board?.ghostTargets).toEqual([ring]);
    expect(captured.board?.onGhostPress).toBe(dismissGhost);
    expect(captured.actionBar?.publishBlocked).toBe(true);
    expect(captured.actionBar?.saveBlockedLine).not.toBeNull();
  });

  it('gives Save back once the last ring is tapped away', () => {
    const dismissGhost = vi.fn();
    const { rerender } = render(drawerWith({ ghosts: [ring], ghostTargets: [ring], dismissGhost }));
    rerender(drawerWith({ ghosts: [], ghostTargets: [], dismissGhost }));

    expect(captured.actionBar?.publishBlocked).toBe(false);
    expect(captured.actionBar?.saveBlockedLine).toBeNull();
  });

  it('leaves Save alone outside a remix', () => {
    render(drawerWith(undefined));
    expect(captured.actionBar?.publishBlocked).toBe(false);
    expect(captured.actionBar?.saveBlockedLine).toBeNull();
    expect(captured.board?.ghostTargets).toBeUndefined();
  });
});
