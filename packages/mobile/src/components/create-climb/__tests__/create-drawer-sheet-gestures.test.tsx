// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, act } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

// What this test is about: CreateDrawer must disable the sheet's own drag
// while a sub-sheet is open OR the board is zoomed/mid-pinch, via
// `enablePanDownToClose` — the one prop `@expo/ui/community/bottom-sheet`
// actually wires up on Android (`sheetGesturesEnabled`) and iOS
// (`interactiveDismissDisabled`). `enableContentPanningGesture` /
// `enableHandlePanningGesture` are documented as having no effect on native
// platforms, so this test captures the real prop instead of those.

type ViewMockProps = { children?: ReactNode; onLayout?: unknown; testID?: string };
vi.mock('react-native', () => ({
  View: ({ children, onLayout, testID }: ViewMockProps) =>
    createElement('div', { 'data-measured': onLayout ? 'true' : undefined, 'data-testid': testID }, children),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles, hairlineWidth: 1 },
  useWindowDimensions: () => ({ width: 405, height: 900 }),
}));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 24, bottom: 0 }) }));
vi.mock('../../../hooks/use-window-bottom-inset', () => ({ useWindowBottomInset: () => 48 }));

let lastBottomSheetProps: { enablePanDownToClose?: boolean } = {};
vi.mock('@expo/ui/community/bottom-sheet', () => ({
  default: (props: { enablePanDownToClose?: boolean; children?: ReactNode }) => {
    lastBottomSheetProps = props;
    return createElement('div', null, props.children);
  },
}));
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

let capturedOnInteractionActiveChange: ((active: boolean) => void) | null = null;
vi.mock('../InteractiveCreateBoard', () => ({
  InteractiveCreateBoard: (props: { onInteractionActiveChange?: (active: boolean) => void }) => {
    capturedOnInteractionActiveChange = props.onInteractionActiveChange ?? null;
    return createElement('div', { 'data-node': 'board' });
  },
}));
vi.mock('../CreateDrawerHeader', () => ({
  CreateDrawerHeader: () => createElement('div', { 'data-node': 'header' }),
}));
vi.mock('../CreateDrawerActionBar', () => ({
  CreateDrawerActionBar: () => createElement('div', { 'data-node': 'action-bar' }),
}));
vi.mock('../CreateDrawerForm', () => ({ CreateDrawerForm: () => createElement('div', { 'data-node': 'form' }) }));
vi.mock('../OpenDraftsSection', () => ({ OpenDraftsSection: () => createElement('div', { 'data-node': 'drafts' }) }));
vi.mock('../InlineConfirmBanner', () => ({
  InlineConfirmBanner: () => createElement('div', { 'data-node': 'confirm-banner' }),
}));
vi.mock('../DuplicateBanner', () => ({
  DuplicateBanner: () => createElement('div', { 'data-node': 'duplicate-banner' }),
}));

import { CreateDrawer } from '../CreateDrawer';

const board = { boardName: 'kilter' as const, layoutId: 1, sizeId: 10, setIds: '1,2', angle: 40 };
const boardHolds = { holdTargets: [], boardWidth: 650, boardHeight: 1000 };

type Controller = Parameters<typeof CreateDrawer>[0]['controller'];

function makeController(): Controller {
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
    frameCount: 1,
    currentFrameIndex: 0,
    duplicateFrame: vi.fn(),
    deleteFrame: vi.fn(),
    prevFrame: vi.fn(),
    nextFrame: vi.fn(),
    canSetActive: false,
    handleSetActive: vi.fn(),
    saveState: 'ready',
    handleSave: vi.fn(),
    publishBlocked: false,
    draftStatus: null,
    pendingNewClimb: false,
    confirmNewClimb: vi.fn(),
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
  } as unknown as Controller;
}

function renderDrawer(subSheetOpen: boolean) {
  return render(
    createElement(CreateDrawer, {
      board,
      controller: makeController(),
      boardHolds,
      onLongPressHold: vi.fn(),
      subSheetOpen,
      onLoadDraft: vi.fn(),
      onClose: vi.fn(),
      onViewDuplicate: vi.fn(),
    }),
  );
}

describe('CreateDrawer sheet-gesture gating', () => {
  it('starts with pan-down-to-close enabled at rest', () => {
    renderDrawer(false);
    expect(lastBottomSheetProps.enablePanDownToClose).toBe(true);
  });

  it('disables pan-down-to-close while the role-picker sub-sheet is open', () => {
    renderDrawer(true);
    expect(lastBottomSheetProps.enablePanDownToClose).toBe(false);
  });

  it('disables pan-down-to-close when the board reports it is zoomed or mid-pinch', () => {
    renderDrawer(false);
    expect(lastBottomSheetProps.enablePanDownToClose).toBe(true);

    act(() => {
      capturedOnInteractionActiveChange?.(true);
    });
    expect(lastBottomSheetProps.enablePanDownToClose).toBe(false);

    act(() => {
      capturedOnInteractionActiveChange?.(false);
    });
    expect(lastBottomSheetProps.enablePanDownToClose).toBe(true);
  });
});
