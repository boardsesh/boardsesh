// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

// The drawer derives its peek snap-point from the MEASURED above-fold height, so
// anything that mounts inside a measured region moves `peekHeight` and re-snaps
// the sheet. That collapsed an expanded drawer the instant a banner appeared —
// hiding the very climb the banner was asking the climber to discard.
//
// The status row solved the same problem by reserving a constant line box. The
// banners can't: reserving ~100dp permanently for something rarely on screen
// costs more above-fold budget than the board can spare. So they live BETWEEN the
// two measured blocks and are measured by neither.

type ViewMockProps = { children?: ReactNode; onLayout?: unknown; testID?: string };
vi.mock('react-native', () => ({
  View: ({ children, onLayout, testID }: ViewMockProps) =>
    createElement('div', { 'data-measured': onLayout ? 'true' : undefined, 'data-testid': testID }, children),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles, hairlineWidth: 1 },
  useWindowDimensions: () => ({ width: 405, height: 900 }),
}));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 24, bottom: 0 }) }));
vi.mock('../../../hooks/use-window-bottom-inset', () => ({ useWindowBottomInset: () => 48 }));
vi.mock('@expo/ui/community/bottom-sheet', () => ({
  default: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  BottomSheetScrollView: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({ systemColors: { secondaryBackground: '#221A33' } }),
}));
vi.mock('../../../theme/tokens', () => ({
  spacing: { 1: 4, 2: 8, 3: 12, 4: 16, 6: 24 },
  sheetStyles: { background: {} },
}));
vi.mock('../InteractiveCreateBoard', () => ({
  InteractiveCreateBoard: () => createElement('div', { 'data-node': 'board' }),
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

function makeController(overrides: Record<string, unknown>): Controller {
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
    ...overrides,
  } as unknown as Controller;
}

function renderDrawer(overrides: Record<string, unknown>) {
  const { container } = render(
    createElement(CreateDrawer, {
      board,
      controller: makeController(overrides),
      boardHolds,
      onLongPressHold: vi.fn(),
      subSheetOpen: false,
      onLoadDraft: vi.fn(),
      onClose: vi.fn(),
      onViewDuplicate: vi.fn(),
    }),
  );
  return {
    container,
    measured: Array.from(container.querySelectorAll('[data-measured="true"]')),
    node: (name: string) => container.querySelector(`[data-node="${name}"]`),
  };
}

const measuredNodeNames = (result: ReturnType<typeof renderDrawer>) =>
  result.measured
    .flatMap((block) => Array.from(block.querySelectorAll('[data-node]')))
    .map((el) => el.getAttribute('data-node'))
    .sort();

describe('CreateDrawer measured above-fold region', () => {
  it('measures the header and the board block, which is what sizes the peek', () => {
    const { measured, node } = renderDrawer({});
    expect(measured.length).toBe(2);
    expect(measured.some((block) => block.contains(node('header')))).toBe(true);
    expect(measured.some((block) => block.contains(node('board')))).toBe(true);
    expect(measured.some((block) => block.contains(node('action-bar')))).toBe(true);
  });

  it('keeps the transient banners out of the measured above-fold region', () => {
    // Put either banner back inside a measured block and its mount changes
    // `peekHeight`, which re-snaps the sheet out from under the climber.
    const confirm = renderDrawer({ pendingNewClimb: true });
    expect(confirm.node('confirm-banner')).toBeTruthy();
    expect(confirm.measured.some((block) => block.contains(confirm.node('confirm-banner')))).toBe(false);

    const duplicate = renderDrawer({
      publishDuplicateError: { existingClimbUuid: 'x', existingClimbName: 'Other climb' },
    });
    expect(duplicate.node('duplicate-banner')).toBeTruthy();
    expect(duplicate.measured.some((block) => block.contains(duplicate.node('duplicate-banner')))).toBe(false);
  });

  it('measures the same nodes whether or not a banner is showing', () => {
    // The real invariant: the measured set is banner-independent, so the peek
    // height cannot move when one appears.
    const without = renderDrawer({});
    const withBanner = renderDrawer({ pendingNewClimb: true });

    expect(measuredNodeNames(withBanner)).toEqual(measuredNodeNames(without));
  });
});
