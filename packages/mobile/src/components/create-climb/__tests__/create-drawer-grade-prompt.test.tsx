// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import { createElement, forwardRef, useEffect, useImperativeHandle, type ReactNode } from 'react';

// #5954: Save stays enabled when the setter grade is the only thing missing, and
// the tap is answered by the drawer — the grade rail is below the fold, so the
// sheet opens and scrolls just far enough to show it. This suite pins the
// drawer's half: what it does with `focusGradeSignal`.

type LayoutEvent = { nativeEvent: { layout: { x: number; y: number; width: number; height: number } } };
type ViewMockProps = { children?: ReactNode; onLayout?: (event: LayoutEvent) => void; testID?: string };

/** Heights the two measured above-fold blocks report, keyed by testID. */
const MEASURED_HEIGHTS: Record<string, number> = {
  'create-drawer-measured-header': 60,
  'create-drawer-measured-board-block': 640,
};
/** Where the form says the grade rail sits inside it. */
const GRADE_BOX = { y: 0, height: 84 };

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
vi.mock('../InteractiveCreateBoard', () => ({
  InteractiveCreateBoard: () => createElement('div', { 'data-node': 'board' }),
}));
vi.mock('../CreateDrawerHeader', () => ({
  CreateDrawerHeader: () => createElement('div', { 'data-node': 'header' }),
}));
vi.mock('../CreateDrawerActionBar', () => ({
  CreateDrawerActionBar: () => createElement('div', { 'data-node': 'action-bar' }),
}));
const formProps = vi.hoisted(() => ({ last: null as null | Record<string, unknown> }));
// The lost-hold ring layer draws through react-native-svg and has its own suite.
vi.mock('../LostHoldGhostLayer', () => ({ LostHoldGhostLayer: () => null }));
vi.mock('../CreateDrawerForm', () => ({
  CreateDrawerForm: (props: { onSetterGradeLayout?: (event: LayoutEvent) => void } & Record<string, unknown>) => {
    formProps.last = props;
    const { onSetterGradeLayout } = props;
    // The real form forwards the grade row's own onLayout.
    useEffect(() => {
      onSetterGradeLayout?.({ nativeEvent: { layout: { x: 0, width: 373, ...GRADE_BOX } } });
    }, [onSetterGradeLayout]);
    return createElement('div', { 'data-node': 'form' });
  },
}));
vi.mock('../OpenDraftsSection', () => ({ OpenDraftsSection: () => createElement('div', { 'data-node': 'drafts' }) }));
// The real banners report the space they take (their own root's onLayout, top
// margin included). Stand-ins do the same with fixed numbers.
const CONFIRM_BANNER_FOOTPRINT = 96;
const DUPLICATE_BANNER_FOOTPRINT = 70;
function footprintBanner(footprint: number) {
  return function BannerMock({ onFootprint }: { onFootprint?: (height: number) => void }) {
    useEffect(() => {
      onFootprint?.(footprint);
    }, [onFootprint]);
    return createElement('div', { 'data-node': 'banner' });
  };
}
vi.mock('../InlineConfirmBanner', () => ({ InlineConfirmBanner: footprintBanner(96) }));
vi.mock('../DuplicateBanner', () => ({ DuplicateBanner: footprintBanner(70) }));
vi.mock('../CreateRoutePlaybackSlot', () => ({
  CreateRoutePlaybackSlot: () => createElement('div', { 'data-node': 'route-slot' }),
}));

import { CreateDrawer } from '../CreateDrawer';

const board = { boardName: 'spray' as const, layoutId: 9001, sizeId: 9001, setIds: '1', angle: 25 };
const boardHolds = { holdTargets: [], boardWidth: 650, boardHeight: 1000 };

type Controller = Parameters<typeof CreateDrawer>[0]['controller'];

function makeController(focusGradeSignal: number, overrides: Record<string, unknown> = {}): Controller {
  return {
    name: '',
    setName: vi.fn(),
    focusNameSignal: 0,
    focusGradeSignal,
    litUpHoldsMap: {},
    frameCount: 1,
    currentFrameIndex: 0,
    blankClimbEpoch: 0,
    supportsMultiFrame: true,
    routeMode: false,
    showRouteTransport: false,
    showSetterGrade: true,
    setterGradeMissing: true,
    setterGradeDifficultyId: null,
    playback: {},
    saveState: 'ready',
    handleSave: vi.fn(),
    publishBlocked: false,
    draftStatus: null,
    pendingNewClimb: false,
    publishDuplicateError: null,
    isDraft: false,
    ...overrides,
  } as unknown as Controller;
}

function drawerElement(focusGradeSignal: number, overrides: Record<string, unknown> = {}) {
  return createElement(CreateDrawer, {
    board,
    controller: makeController(focusGradeSignal, overrides),
    boardHolds,
    onLongPressHold: vi.fn(),
    subSheetOpen: false,
    onLoadDraft: vi.fn(),
    onClose: vi.fn(),
    onViewDuplicate: vi.fn(),
  });
}

describe('CreateDrawer grade prompt', () => {
  beforeEach(() => {
    sheet.snapToIndex.mockClear();
    scroll.scrollTo.mockClear();
    formProps.last = null;
  });

  it('does not scroll or open the sheet on its own', () => {
    render(drawerElement(0));
    expect(scroll.scrollTo).not.toHaveBeenCalled();
    // The peek re-snap targets the index the sheet is already at, never the open one.
    expect(sheet.snapToIndex).not.toHaveBeenCalledWith(1);
  });

  it('opens the sheet and scrolls the grade rail into view when Save asks for the grade', () => {
    const { rerender } = render(drawerElement(0));
    rerender(drawerElement(1));

    expect(sheet.snapToIndex).toHaveBeenCalledWith(1);
    // Rail bottom in the content: 8 padding + 700 above the fold + 16 below-fold
    // padding + the 84 rail = 808. Open viewport: 900 - 24 inset - 24 grabber =
    // 852. Clearance: 16 + the 48 bottom inset. 808 + 64 - 852 = 20.
    expect(scroll.scrollTo).toHaveBeenCalledTimes(1);
    expect(scroll.scrollTo).toHaveBeenCalledWith({ y: 20, animated: true });
  });

  it('counts a banner sitting between the header and the board', () => {
    // The banners are measured by neither above-fold block, so they are not in
    // the peek height — but they push the rail down by their own height.
    const withConfirm = { pendingNewClimb: true };
    const { rerender } = render(drawerElement(0, withConfirm));
    rerender(drawerElement(1, withConfirm));
    expect(scroll.scrollTo).toHaveBeenLastCalledWith({ y: 20 + CONFIRM_BANNER_FOOTPRINT, animated: true });
  });

  it('counts both banners when both are up', () => {
    const both = {
      pendingNewClimb: true,
      publishDuplicateError: { existingClimbName: 'Twin', existingClimbUuid: null },
    };
    const { rerender } = render(drawerElement(0, both));
    rerender(drawerElement(1, both));
    expect(scroll.scrollTo).toHaveBeenLastCalledWith({
      y: 20 + CONFIRM_BANNER_FOOTPRINT + DUPLICATE_BANNER_FOOTPRINT,
      animated: true,
    });
  });

  it('stops counting a banner once it is gone', () => {
    // An unmount fires no layout event, so the last footprint is still in the
    // ref. It must only count while the banner is on screen.
    const { rerender } = render(drawerElement(0, { pendingNewClimb: true }));
    rerender(drawerElement(0, { pendingNewClimb: false }));
    rerender(drawerElement(1, { pendingNewClimb: false }));
    expect(scroll.scrollTo).toHaveBeenLastCalledWith({ y: 20, animated: true });
  });

  it('answers every further tap, not only the first', () => {
    const { rerender } = render(drawerElement(0));
    rerender(drawerElement(1));
    rerender(drawerElement(2));
    expect(scroll.scrollTo).toHaveBeenCalledTimes(2);
  });

  it('stays put when a new climb clears the prompt', () => {
    const { rerender } = render(drawerElement(1));
    scroll.scrollTo.mockClear();
    sheet.snapToIndex.mockClear();

    rerender(drawerElement(0));

    expect(scroll.scrollTo).not.toHaveBeenCalled();
    expect(sheet.snapToIndex).not.toHaveBeenCalledWith(1);
  });

  it('hands the same signal to the form, which highlights the grade row', () => {
    render(drawerElement(3));
    expect(formProps.last?.setterGradeHighlightSignal).toBe(3);
    expect(formProps.last?.setterGradeRequired).toBe(true);
  });
});
