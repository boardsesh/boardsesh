import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { render, screen, fireEvent, act } from '@testing-library/react';
import React from 'react';
import type { AscentFeedItem } from '@boardsesh/graphql/operations/ticks';
import LogbookFeedItem from '../logbook-feed-item';
import { tFromCatalog } from '@/app/__test-helpers__/i18n-mock';

vi.mock('react-i18next', () => ({
  useTranslation: (ns?: string) => ({
    t: (key: string, options?: Record<string, unknown>) => tFromCatalog(ns, key, options),
    i18n: { language: 'en-US' },
  }),
  Trans: ({ children }: { children?: React.ReactNode }) => children ?? null,
}));

// --- Capture hooks ---

type SwipeOptions = {
  onSwipeLeft: () => void;
  onSwipeRight: () => void;
  onSwipeRightLong?: () => void;
  onSwipeZoneChange?: (zone: string) => void;
  disabled?: boolean;
};

let capturedSwipeOptions: SwipeOptions | null = null;
const updateTickAsyncMock = vi.fn();
const setCurrentClimbMock = vi.fn();
const previewClimbFromBrowseMock = vi.fn();
const dispatchOpenPlayDrawerMock = vi.fn();
const boardDataMocks = vi.hoisted(() => ({
  getGradesForBoard: vi.fn((boardName: string) =>
    boardName === 'moonboard'
      ? [{ difficulty_id: 18, difficulty_name: '6b/V4', v_grade: 'V4' }]
      : [{ difficulty_id: 20, difficulty_name: '7a/V6', v_grade: 'V6' }],
  ),
}));
// Holder so tests can swap queue-actions availability without remounting.
const queueActionsState: {
  value: {
    setCurrentClimb: typeof setCurrentClimbMock;
    previewClimbFromBrowse: typeof previewClimbFromBrowseMock;
  } | null;
} = {
  value: { setCurrentClimb: setCurrentClimbMock, previewClimbFromBrowse: previewClimbFromBrowseMock },
};
// Holder object so tests can mutate isPending and the mock reads the
// current value on every render (avoids the stale-by-value closure
// that would result from binding a plain `let` into the mock factory).
const updateTickState = { isPending: false };

// --- Mocks ---

vi.mock('../logbook-feed-item.module.css', () => ({
  default: new Proxy({}, { get: (_t, p) => String(p) }),
}));

vi.mock('@/app/components/climb-card/ascent-status.module.css', () => ({
  default: new Proxy({}, { get: (_t, p) => String(p) }),
}));

vi.mock('@/app/components/swipeable-drawer/swipeable-drawer.module.css', () => ({
  default: new Proxy({}, { get: (_t, p) => String(p) }),
}));

vi.mock('@/app/hooks/use-swipe-actions', () => ({
  useSwipeActions: (options: SwipeOptions) => {
    capturedSwipeOptions = options;
    return {
      swipeHandlers: { ref: vi.fn() },
      swipeLeftConfirmed: false,
      contentRef: vi.fn(),
      leftActionRef: vi.fn(),
      rightActionRef: vi.fn(),
    };
  },
}));

vi.mock('@/app/hooks/use-update-tick', () => ({
  useUpdateTick: () => ({
    mutateAsync: updateTickAsyncMock,
    get isPending() {
      return updateTickState.isPending;
    },
  }),
}));

vi.mock('@/app/hooks/use-drawer-drag-resize', () => ({
  useDrawerDragResize: () => ({
    paperRef: { current: null },
    dragHandlers: {},
  }),
}));

vi.mock('@/app/hooks/use-is-dark-mode', () => ({
  useIsDarkMode: () => false,
}));

vi.mock('@/app/hooks/use-grade-format', () => ({
  useGradeFormat: () => ({
    formatGrade: (g: string) => g,
    getGradeColor: () => '#888',
  }),
}));

vi.mock('@/app/lib/default-board-configs', () => ({
  getDefaultBoardConfig: () => ({ sizeId: 10, setIds: '1,26' }),
}));

vi.mock('@/app/lib/board-utils', () => ({
  getBoardDetailsForBoard: () => ({
    board_name: 'kilter',
    layout_id: 1,
    size_id: 10,
    set_ids: '1,26',
  }),
}));

vi.mock('@/app/lib/climb-action-utils', () => ({
  getExcludedClimbActions: () => [],
}));

vi.mock('@/app/lib/board-data', () => ({
  getGradesForBoard: boardDataMocks.getGradesForBoard,
}));

vi.mock('@/app/components/activity-feed/ascent-thumbnail', () => ({
  default: ({ onClick }: { onClick?: (e: React.MouseEvent) => void }) => (
    <button type="button" data-testid="ascent-thumbnail" onClick={(e) => onClick?.(e)} />
  ),
}));

vi.mock('@/app/components/graphql-queue', () => ({
  useOptionalQueueActions: () => queueActionsState.value,
}));

vi.mock('@/app/components/queue-control/play-drawer-event', () => ({
  dispatchOpenPlayDrawer: () => dispatchOpenPlayDrawerMock(),
}));

vi.mock('@/app/lib/analytics', () => ({
  track: vi.fn(),
}));

vi.mock('@/app/components/ascent-status/ascent-status-icon', () => ({
  AscentStatusIcon: () => <span data-testid="status-icon" />,
}));

vi.mock('@/app/components/climb-actions', () => ({
  ClimbActions: () => <div data-testid="climb-actions" />,
}));

vi.mock('@/app/components/climb-card/drawer-climb-header', () => ({
  default: () => <div data-testid="drawer-climb-header" />,
}));

vi.mock('../ascent-to-climb', () => ({
  ascentFeedItemToClimb: (item: AscentFeedItem) => ({ uuid: item.climbUuid, name: item.climbName }),
}));

vi.mock('../../logbook/tick-controls', () => ({
  InlineStarPicker: ({ onSelect }: { onSelect: (v: number | null) => void }) => (
    <button data-testid="inline-star-picker" onClick={() => onSelect(3)}>
      stars
    </button>
  ),
  InlineGradePicker: ({ onSelect }: { onSelect: (v: number) => void }) => (
    <button data-testid="inline-grade-picker" onClick={() => onSelect(21)}>
      grade
    </button>
  ),
  InlineTriesPicker: ({ onSelect }: { onSelect: (v: number) => void }) => (
    <button data-testid="inline-tries-picker" onClick={() => onSelect(5)}>
      tries
    </button>
  ),
}));

// Dynamic imports: next/dynamic resolves the loader; return a simple component from each.
vi.mock('next/dynamic', () => ({
  default: () => () => null,
}));

// --- Import component after mocks ---

// --- Helpers ---

function makeItem(overrides: Partial<AscentFeedItem> = {}): AscentFeedItem {
  return {
    uuid: 'tick-1',
    climbUuid: 'climb-1',
    climbName: 'Test Climb',
    setterUsername: null,
    boardType: 'kilter',
    boardId: null,
    boardDisplayName: null,
    layoutId: 1,
    angle: 40,
    isMirror: false,
    status: 'send',
    attemptCount: 2,
    quality: 4,
    difficulty: 20,
    difficultyName: '7a/V6',
    consensusDifficulty: 20,
    consensusDifficultyName: '7a/V6',
    qualityAverage: 3.5,
    isBenchmark: false,
    isNoMatch: false,
    comment: 'Nice send!',
    climbedAt: new Date('2026-04-01T12:00:00Z').toISOString(),
    frames: 'p1r14',
    ...overrides,
  };
}

beforeEach(() => {
  capturedSwipeOptions = null;
  updateTickAsyncMock.mockReset();
  setCurrentClimbMock.mockReset();
  previewClimbFromBrowseMock.mockReset();
  dispatchOpenPlayDrawerMock.mockReset();
  boardDataMocks.getGradesForBoard.mockClear();
  queueActionsState.value = {
    setCurrentClimb: setCurrentClimbMock,
    previewClimbFromBrowse: previewClimbFromBrowseMock,
  };
  updateTickState.isPending = false;
});

// --- Tests ---

describe('LogbookFeedItem', () => {
  it('renders non-edit mode with comment and more-actions button', () => {
    render(<LogbookFeedItem item={makeItem()} />);
    expect(screen.getByText('Test Climb')).toBeDefined();
    expect(screen.getByText('Nice send!')).toBeDefined();
    expect(screen.getByLabelText('More actions')).toBeDefined();
  });

  it('renders edit mode with TextField and save/cancel buttons', () => {
    render(<LogbookFeedItem item={makeItem()} isEditing />);
    expect(screen.getByLabelText('Edit tick comment')).toBeDefined();
    expect(screen.getByLabelText('Save')).toBeDefined();
    expect(screen.getByLabelText('Cancel editing')).toBeDefined();
    expect(screen.queryByLabelText('More actions')).toBeNull();
  });

  it('uses MoonBoard grades for the editable user grade label', () => {
    render(
      <LogbookFeedItem
        item={makeItem({
          boardType: 'moonboard',
          layoutId: 5,
          difficulty: 18,
          difficultyName: null,
          consensusDifficulty: null,
          consensusDifficultyName: null,
        })}
        isEditing
      />,
    );

    expect(boardDataMocks.getGradesForBoard).toHaveBeenCalledWith('moonboard');
    expect(screen.getByText('6b/V4')).toBeDefined();
  });

  it('disables swipe actions while editing', () => {
    render(<LogbookFeedItem item={makeItem()} isEditing />);
    expect(capturedSwipeOptions?.disabled).toBe(true);
  });

  it('fires onEdit when left-swipe completes', () => {
    const onEdit = vi.fn();
    const item = makeItem();
    render(<LogbookFeedItem item={item} onEdit={onEdit} />);
    capturedSwipeOptions?.onSwipeLeft();
    expect(onEdit).toHaveBeenCalledWith(item);
  });

  it('fires onDelete when long right-swipe completes', () => {
    const onDelete = vi.fn();
    const item = makeItem();
    render(<LogbookFeedItem item={item} onDelete={onDelete} />);
    capturedSwipeOptions?.onSwipeRightLong?.();
    expect(onDelete).toHaveBeenCalledWith('tick-1');
  });

  it('calls onCancelEdit after successful save', async () => {
    updateTickAsyncMock.mockResolvedValue({ uuid: 'tick-1' });
    const onCancelEdit = vi.fn();
    render(<LogbookFeedItem item={makeItem()} isEditing onCancelEdit={onCancelEdit} />);
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Save'));
    });
    expect(updateTickAsyncMock).toHaveBeenCalledWith({
      uuid: 'tick-1',
      input: expect.objectContaining({
        status: 'send',
        attemptCount: 2,
        comment: 'Nice send!',
      }),
    });
    expect(onCancelEdit).toHaveBeenCalledOnce();
  });

  it('keeps edit open when save fails', async () => {
    updateTickAsyncMock.mockRejectedValue(new Error('boom'));
    const onCancelEdit = vi.fn();
    render(<LogbookFeedItem item={makeItem()} isEditing onCancelEdit={onCancelEdit} />);
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Save'));
    });
    expect(onCancelEdit).not.toHaveBeenCalled();
  });

  it('opens status popover when status badge is clicked', () => {
    render(<LogbookFeedItem item={makeItem()} isEditing />);
    fireEvent.click(screen.getByLabelText(/Change ascent status/));
    expect(screen.getByText('Flash')).toBeDefined();
    expect(screen.getByText('Send')).toBeDefined();
    expect(screen.getByText('Attempt')).toBeDefined();
  });

  it('preserves quality in save payload when status is changed to attempt', async () => {
    updateTickAsyncMock.mockResolvedValue({});
    render(<LogbookFeedItem item={makeItem()} isEditing />);
    fireEvent.click(screen.getByLabelText(/Change ascent status/));
    fireEvent.click(screen.getByText('Attempt'));
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Save'));
    });
    // The component now preserves the existing quality when changing status to attempt
    expect(updateTickAsyncMock).toHaveBeenCalledWith({
      uuid: 'tick-1',
      input: expect.objectContaining({ status: 'attempt', quality: 4 }),
    });
  });

  it('expands star picker when user-stars cell is clicked in edit mode', () => {
    render(<LogbookFeedItem item={makeItem()} isEditing />);
    fireEvent.click(screen.getByLabelText(/Quality:/));
    expect(screen.getByTestId('inline-star-picker')).toBeDefined();
  });

  it('selecting a star updates edit state and collapses the picker', async () => {
    updateTickAsyncMock.mockResolvedValue({});
    render(<LogbookFeedItem item={makeItem()} isEditing />);
    fireEvent.click(screen.getByLabelText(/Quality:/));
    fireEvent.click(screen.getByTestId('inline-star-picker'));
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Save'));
    });
    expect(updateTickAsyncMock).toHaveBeenCalledWith({
      uuid: 'tick-1',
      input: expect.objectContaining({ quality: 3 }),
    });
  });

  it('tags the container for the swipe-hint when isSwipeHintTarget is true', () => {
    const { container } = render(<LogbookFeedItem item={makeItem()} isSwipeHintTarget />);
    expect(container.querySelector('#onboarding-logbook-card')).not.toBeNull();
  });

  it('does not tag the container when isSwipeHintTarget is false', () => {
    const { container } = render(<LogbookFeedItem item={makeItem()} />);
    expect(container.querySelector('#onboarding-logbook-card')).toBeNull();
  });

  it('marks both swipe action layers aria-hidden', () => {
    const { container } = render(<LogbookFeedItem item={makeItem()} />);
    // The CSS-module Proxy mock returns the prop name as the class,
    // so both action layers are reachable via their source class names.
    const left = container.querySelector('.leftActionLayer');
    const right = container.querySelector('.rightActionLayer');
    expect(left?.getAttribute('aria-hidden')).toBe('true');
    expect(right?.getAttribute('aria-hidden')).toBe('true');
  });

  it('reflects updateTick.isPending via the getter mock without remount', () => {
    updateTickState.isPending = true;
    const { rerender } = render(<LogbookFeedItem item={makeItem()} isEditing />);
    const saveBtn = screen.getByLabelText('Save') as HTMLButtonElement;
    expect(saveBtn.disabled).toBe(true);

    updateTickState.isPending = false;
    rerender(<LogbookFeedItem item={makeItem()} isEditing />);
    const saveBtn2 = screen.getByLabelText('Save') as HTMLButtonElement;
    expect(saveBtn2.disabled).toBe(false);
  });

  it('row tap calls previewClimbFromBrowse with the row climb', () => {
    const { container } = render(<LogbookFeedItem item={makeItem()} />);
    const row = container.querySelector('.swipeableContent') as HTMLElement;
    fireEvent.click(row);
    // previewClimbFromBrowse handles the solo/party fork internally — solo
    // calls setCurrentClimb + opens the drawer; party only opens the drawer.
    expect(previewClimbFromBrowseMock).toHaveBeenCalledTimes(1);
    expect(previewClimbFromBrowseMock).toHaveBeenCalledWith(
      expect.objectContaining({ uuid: 'climb-1', name: 'Test Climb' }),
    );
  });

  it('row tap is a no-op in edit mode', () => {
    const { container } = render(<LogbookFeedItem item={makeItem()} isEditing />);
    const row = container.querySelector('.swipeableContent') as HTMLElement;
    fireEvent.click(row);
    expect(previewClimbFromBrowseMock).not.toHaveBeenCalled();
  });

  it('row tap is a no-op when queue actions are unavailable', () => {
    queueActionsState.value = null;
    const { container } = render(<LogbookFeedItem item={makeItem()} />);
    const row = container.querySelector('.swipeableContent') as HTMLElement;
    fireEvent.click(row);
    expect(previewClimbFromBrowseMock).not.toHaveBeenCalled();
  });

  it('row is keyboard-accessible with role/tabIndex/aria-label', () => {
    const { container } = render(<LogbookFeedItem item={makeItem()} />);
    const row = container.querySelector('.swipeableContent') as HTMLElement;
    expect(row.getAttribute('role')).toBe('button');
    expect(row.getAttribute('tabIndex')).toBe('0');
    expect(row.getAttribute('aria-label')).toBe('Set Test Climb as active climb');
  });

  it('row is not focusable when edit mode is active', () => {
    const { container } = render(<LogbookFeedItem item={makeItem()} isEditing />);
    const row = container.querySelector('.swipeableContent') as HTMLElement;
    expect(row.getAttribute('role')).toBeNull();
    expect(row.getAttribute('tabIndex')).toBeNull();
  });

  it('Enter/Space on the row fires previewClimbFromBrowse', () => {
    const { container } = render(<LogbookFeedItem item={makeItem()} />);
    const row = container.querySelector('.swipeableContent') as HTMLElement;
    fireEvent.keyDown(row, { key: 'Enter', target: row, currentTarget: row });
    fireEvent.keyDown(row, { key: ' ', target: row, currentTarget: row });
    expect(previewClimbFromBrowseMock).toHaveBeenCalledTimes(2);
  });

  it('other keys on the row do not fire previewClimbFromBrowse', () => {
    const { container } = render(<LogbookFeedItem item={makeItem()} />);
    const row = container.querySelector('.swipeableContent') as HTMLElement;
    fireEvent.keyDown(row, { key: 'Tab', target: row, currentTarget: row });
    fireEvent.keyDown(row, { key: 'a', target: row, currentTarget: row });
    expect(previewClimbFromBrowseMock).not.toHaveBeenCalled();
  });

  it('thumbnail tap calls previewClimbFromBrowse with the climb', () => {
    render(<LogbookFeedItem item={makeItem()} />);
    fireEvent.click(screen.getByTestId('ascent-thumbnail'));
    expect(previewClimbFromBrowseMock).toHaveBeenCalledTimes(1);
    expect(previewClimbFromBrowseMock).toHaveBeenCalledWith(
      expect.objectContaining({ uuid: 'climb-1', name: 'Test Climb' }),
    );
  });

  it('thumbnail tap does not bubble to the row handler', () => {
    render(<LogbookFeedItem item={makeItem()} />);
    fireEvent.click(screen.getByTestId('ascent-thumbnail'));
    // Thumbnail fires previewClimbFromBrowse once; the row handler would fire
    // it a second time if propagation wasn't stopped.
    expect(previewClimbFromBrowseMock).toHaveBeenCalledTimes(1);
  });

  it('3-dot menu click opens the actions drawer without setting active', () => {
    render(<LogbookFeedItem item={makeItem()} />);
    fireEvent.click(screen.getByLabelText('More actions'));
    expect(previewClimbFromBrowseMock).not.toHaveBeenCalled();
  });

  it('keeps the comment row container mounted in both modes (U8)', () => {
    const { container, rerender } = render(<LogbookFeedItem item={makeItem({ comment: '' })} />);
    const emptyRow = container.querySelector('.commentRow');
    expect(emptyRow).not.toBeNull();

    rerender(<LogbookFeedItem item={makeItem({ comment: '' })} isEditing />);
    const editRow = container.querySelector('.commentRow');
    expect(editRow).not.toBeNull();
  });
});
