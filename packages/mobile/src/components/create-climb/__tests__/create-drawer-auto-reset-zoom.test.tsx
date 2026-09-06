// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import { createElement, useEffect, type ReactNode, type RefObject } from 'react';
import type { CreateBoardControls } from '../InteractiveCreateBoard';

// One spy standing in for the board's zoom handle, so the drawer's auto-resets
// can be asserted without a real gesture stack.
const resetZoomSpy = vi.hoisted(() => vi.fn());
// The transport's seek, so the frame-navigation path can be driven end to end.
const seekSpy = vi.hoisted(() => vi.fn());

type ViewMockProps = { children?: ReactNode; onLayout?: unknown; testID?: string };
vi.mock('react-native', () => ({
  View: ({ children }: ViewMockProps) => createElement('div', null, children),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles, hairlineWidth: 1 },
  useWindowDimensions: () => ({ width: 405, height: 900 }),
}));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 24, bottom: 0 }) }));
vi.mock('../../../hooks/use-window-bottom-inset', () => ({ useWindowBottomInset: () => 48 }));
vi.mock('@expo/ui/community/bottom-sheet', () => ({
  default: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
}));
// The drawer scrolls in RNGH's own ScrollView (so the board's pinch can declare
// a relation with it), so the real RNGH module is in this file's import graph.
vi.mock('react-native-gesture-handler', () => ({
  GestureHandlerRootView: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  ScrollView: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({ systemColors: { secondaryBackground: '#221A33' } }),
}));
vi.mock('../../../theme/tokens', () => ({
  spacing: { 1: 4, 2: 8, 3: 12, 4: 16, 6: 24 },
  sheetStyles: { background: {} },
}));

// Publishes the handle the drawer calls, the same way the real board's
// useImperativeHandle does.
vi.mock('../InteractiveCreateBoard', () => ({
  InteractiveCreateBoard: ({ controlRef }: { controlRef?: RefObject<CreateBoardControls | null> }) => {
    useEffect(() => {
      if (controlRef) controlRef.current = { resetZoom: resetZoomSpy };
    }, [controlRef]);
    return createElement('div', { 'data-node': 'board' });
  },
}));
// "Start a new climb" moved off the action bar into the header's overflow menu,
// so the button that stands in for it lives on the header mock now.
vi.mock('../CreateDrawerHeader', () => ({
  CreateDrawerHeader: ({ onSelectOverflowAction }: { onSelectOverflowAction?: (action: string) => void }) =>
    createElement('button', { 'data-new-climb': 'true', onClick: () => onSelectOverflowAction?.('newClimb') }),
}));
vi.mock('../CreateDrawerActionBar', () => ({
  CreateDrawerActionBar: () => createElement('div', { 'data-node': 'action-bar' }),
}));
vi.mock('../CreateDrawerForm', () => ({ CreateDrawerForm: () => createElement('div') }));
vi.mock('../OpenDraftsSection', () => ({
  OpenDraftsSection: ({ onLoadDraft }: { onLoadDraft?: (climb: unknown) => void }) =>
    createElement('button', { 'data-load-draft': 'true', onClick: () => onLoadDraft?.({ uuid: 'draft-1' }) }),
}));
vi.mock('../InlineConfirmBanner', () => ({
  InlineConfirmBanner: ({ onConfirm }: { onConfirm?: () => void }) =>
    createElement('button', { 'data-confirm-new': 'true', onClick: onConfirm }),
}));
vi.mock('../DuplicateBanner', () => ({ DuplicateBanner: () => createElement('div') }));
// Stands in for the route slot, exposing its seek so the transport path — the
// only frame navigation left, now that the action bar's stepper is gone — can be
// driven from here. The real one mounts PlaybackControls (Reanimated, a
// GestureDetector) at 2+ frames.
type SlotMockProps = { playback?: { seek: (index: number) => void } };
vi.mock('../CreateRoutePlaybackSlot', () => ({
  CreateRoutePlaybackSlot: ({ playback }: SlotMockProps) =>
    createElement('button', { 'data-seek': 'true', onClick: () => playback?.seek(1) }),
}));

import { CreateDrawer } from '../CreateDrawer';

const board = { boardName: 'kilter' as const, layoutId: 1, sizeId: 10, setIds: '1,2', angle: 40 };
const boardHolds = { holdTargets: [], boardWidth: 650, boardHeight: 1000 };

type Controller = Parameters<typeof CreateDrawer>[0]['controller'];

function makeController(overrides: Record<string, unknown> = {}): Controller {
  return {
    name: '',
    setName: vi.fn(),
    startingCount: 0,
    finishCount: 0,
    focusNameSignal: 0,
    bleConnected: false,
    bleConnecting: false,
    handleToggleBle: vi.fn(),
    litUpHoldsMap: {},
    handlePaint: vi.fn(),
    showAllHolds: false,
    selectedBrush: 'HAND',
    setSelectedBrush: vi.fn(),
    canUndo: false,
    canRedo: false,
    undo: vi.fn(),
    redo: vi.fn(),
    handleClearHolds: vi.fn(),
    handleNewClimb: vi.fn(),
    supportsMultiFrame: true,
    frameCount: 1,
    currentFrameIndex: 0,
    duplicateFrame: vi.fn(),
    deleteFrame: vi.fn(),
    handedOff: false,
    playback: {
      isPlaying: false,
      speed: 1,
      paceMs: 750,
      play: vi.fn(),
      pause: vi.fn(),
      seek: seekSpy,
      setSpeed: vi.fn(),
    },
    canSetActive: false,
    handleSetActive: vi.fn(),
    saveState: 'ready',
    handleSave: vi.fn(),
    publishBlocked: false,
    draftStatus: null,
    pendingNewClimb: false,
    confirmNewClimb: vi.fn(),
    blankClimbEpoch: 0,
    cancelNewClimb: vi.fn(),
    publishDuplicateError: null,
    dismissDuplicateError: vi.fn(),
    description: '',
    setDescription: vi.fn(),
    noMatch: false,
    setNoMatch: vi.fn(),
    isDraft: true,
    setIsDraft: vi.fn(),
    setShowAllHolds: vi.fn(),
    ...overrides,
  } as unknown as Controller;
}

const onLoadDraft = vi.fn();
const drawer = (controllerOverrides: Record<string, unknown> = {}) =>
  createElement(CreateDrawer, {
    board,
    controller: makeController(controllerOverrides),
    boardHolds,
    onLongPressHold: vi.fn(),
    subSheetOpen: false,
    onLoadDraft,
    onClose: vi.fn(),
    onViewDuplicate: vi.fn(),
  });

/**
 * Zoom is a view of ONE frame of ONE climb. Carrying it across a frame or climb
 * change leaves the climber staring at a magnified corner of something they
 * didn't ask for. Both sibling surfaces already dropped it on these events
 * (SwipeBoardCarousel, PlayDrawer); the create board dropped it on none.
 */
describe('CreateDrawer auto-reset zoom', () => {
  beforeEach(() => {
    resetZoomSpy.mockClear();
    seekSpy.mockClear();
    onLoadDraft.mockClear();
  });

  it('drops the zoom when the frame changes', () => {
    const { rerender } = render(drawer({ frameCount: 2, currentFrameIndex: 0 }));
    resetZoomSpy.mockClear();

    rerender(drawer({ frameCount: 2, currentFrameIndex: 1 }));
    expect(resetZoomSpy).toHaveBeenCalledTimes(1);
  });

  it('drops the zoom when the transport seeks to another frame', () => {
    // The action bar's prev/next stepper is gone — the transport under the board
    // is the only frame navigation left, so the reset has to survive that path.
    const { container, rerender } = render(drawer({ frameCount: 3, currentFrameIndex: 0 }));
    resetZoomSpy.mockClear();

    (container.querySelector('[data-seek="true"]') as HTMLButtonElement).click();
    expect(seekSpy).toHaveBeenCalledWith(1);

    // ...and the controller reports the frame the seek landed on.
    rerender(drawer({ frameCount: 3, currentFrameIndex: 1 }));
    expect(resetZoomSpy).toHaveBeenCalledTimes(1);
  });

  it('drops the zoom when a deleted frame swaps the one under you', () => {
    // DELETE_FRAME clamps, so removing the middle of three leaves the index at
    // 1 pointing at what used to be frame 2. The index alone misses that.
    const { rerender } = render(drawer({ frameCount: 3, currentFrameIndex: 1 }));
    resetZoomSpy.mockClear();

    rerender(drawer({ frameCount: 2, currentFrameIndex: 1 }));
    expect(resetZoomSpy).toHaveBeenCalledTimes(1);
  });

  it('leaves the zoom alone on a re-render that does not change frame', () => {
    const { rerender } = render(drawer({ frameCount: 2, currentFrameIndex: 1 }));
    resetZoomSpy.mockClear();

    rerender(drawer({ frameCount: 2, currentFrameIndex: 1 }));
    expect(resetZoomSpy).not.toHaveBeenCalled();
  });

  it('drops the zoom when a blank climb actually starts', () => {
    const { rerender } = render(drawer({ blankClimbEpoch: 0 }));
    resetZoomSpy.mockClear();

    rerender(drawer({ blankClimbEpoch: 1 }));
    expect(resetZoomSpy).toHaveBeenCalledTimes(1);
  });

  it('keeps the zoom while New Climb is only ASKING to start one', () => {
    // With unsaved work the press raises the confirmation and returns; the
    // epoch does not move until the reset lands. Keying this on the press
    // instead threw away the zoom of a climb the climber then kept.
    const handleNewClimb = vi.fn();
    const { container, rerender } = render(drawer({ handleNewClimb }));
    resetZoomSpy.mockClear();

    (container.querySelector('[data-new-climb="true"]') as HTMLButtonElement).click();
    expect(handleNewClimb).toHaveBeenCalledTimes(1);
    expect(resetZoomSpy).not.toHaveBeenCalled();

    // ...and cancelling leaves it untouched too.
    rerender(drawer({ pendingNewClimb: false, handleNewClimb }));
    expect(resetZoomSpy).not.toHaveBeenCalled();
  });

  it('drops the zoom when a draft is loaded', () => {
    const { container } = render(drawer());
    resetZoomSpy.mockClear();

    (container.querySelector('[data-load-draft="true"]') as HTMLButtonElement).click();
    expect(resetZoomSpy).toHaveBeenCalledTimes(1);
    expect(onLoadDraft).toHaveBeenCalledTimes(1);
  });
});
