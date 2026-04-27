import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import React from 'react';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import type { Angle, BoardDetails, BoardName, Climb } from '@/app/lib/types';
import type { LogbookEntry } from '@/app/hooks/use-logbook';
import { type QuickTickBarHandle, QuickTickBar } from '../quick-tick-bar';
import { hasPriorHistoryForClimb } from '@/app/hooks/use-tick-save';

// --- Mocks (must be hoisted before imports of the component under test) ---

const mockSaveTick = vi.fn();
const mockLogbookRef: { current: LogbookEntry[] } = { current: [] };

vi.mock('../../board-provider/board-provider-context', () => ({
  useBoardProvider: () => ({
    saveTick: mockSaveTick,
    logbook: mockLogbookRef.current,
    boardName: 'kilter' as BoardName,
    isAuthenticated: true,
    isLoading: false,
    error: null,
    isInitialized: true,
    getLogbook: vi.fn(),
    saveClimb: vi.fn(),
  }),
}));

vi.mock('@/app/lib/analytics', () => ({
  track: vi.fn(),
}));

// Import after mocks.

// --- Fixtures ---

function makeClimb(overrides: Partial<Climb> = {}): Climb {
  return {
    uuid: 'climb-1',
    name: 'Test Climb',
    difficulty: 'V5',
    frames: 'p1r42',
    quality_average: '3.5',
    angle: 40,
    ascensionist_count: 10,
    display_difficulty: 5,
    difficulty_average: 12.5,
    setter_username: 'setter',
    ...overrides,
  } as Climb;
}

function makeBoardDetails(overrides: Partial<BoardDetails> = {}): BoardDetails {
  return {
    board_name: 'kilter' as BoardName,
    layout_id: 1,
    size_id: 10,
    set_ids: [1, 2],
    layout_name: 'Original',
    size_name: '12x12',
    size_description: 'Full',
    set_names: ['Standard'],
    supportsMirroring: true,
    images_to_holds: {},
    holdsData: {},
    edge_left: 0,
    edge_right: 0,
    edge_bottom: 0,
    edge_top: 0,
    boardHeight: 100,
    boardWidth: 100,
    ...overrides,
  } as BoardDetails;
}

function makeLogbookEntry(overrides: Partial<LogbookEntry> = {}): LogbookEntry {
  return {
    uuid: 'log-1',
    climb_uuid: 'climb-1',
    angle: 40,
    is_mirror: false,
    tries: 1,
    quality: null,
    difficulty: null,
    comment: '',
    climbed_at: '2025-01-01T00:00:00Z',
    is_ascent: false,
    status: 'attempt',
    upvotes: 0,
    downvotes: 0,
    commentCount: 0,
    ...overrides,
  };
}

const defaultProps = {
  currentClimb: makeClimb(),
  angle: 40 as Angle,
  boardDetails: makeBoardDetails(),
  onSave: vi.fn(),
  comment: '',
  commentSlot: null,
};

/**
 * Simulate a horizontal swipe on the bar root.
 * react-swipeable uses touch events internally, so we dispatch native touch
 * events with TouchEvent-shaped fields that the library reads.
 */
function _simulateSwipe(el: HTMLElement, deltaX: number) {
  const startX = 200;
  const startY = 100;
  const endX = startX + deltaX;

  fireEvent.touchStart(el, {
    touches: [{ clientX: startX, clientY: startY }],
  });
  // A couple of intermediate points so react-swipeable recognises a swipe.
  fireEvent.touchMove(el, {
    touches: [{ clientX: startX + deltaX / 2, clientY: startY }],
  });
  fireEvent.touchMove(el, {
    touches: [{ clientX: endX, clientY: startY }],
  });
  fireEvent.touchEnd(el, {
    changedTouches: [{ clientX: endX, clientY: startY }],
  });
}

describe('QuickTickBar', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLogbookRef.current = [];
    mockSaveTick.mockResolvedValue(undefined);
    defaultProps.onSave = vi.fn();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('hasPriorHistoryForClimb helper', () => {
    it('prefers userAscents/userAttempts on the climb when present', () => {
      const climbFresh = makeClimb({ uuid: 'c1', userAscents: 0, userAttempts: 0 });
      const climbAttempted = makeClimb({ uuid: 'c2', userAscents: 0, userAttempts: 3 });
      const climbSent = makeClimb({ uuid: 'c3', userAscents: 1, userAttempts: 0 });

      // Logbook contents should be ignored when the climb carries counts.
      const logbook = [makeLogbookEntry({ climb_uuid: 'c1' })];

      expect(hasPriorHistoryForClimb(climbFresh, logbook)).toBe(false);
      expect(hasPriorHistoryForClimb(climbAttempted, [])).toBe(true);
      expect(hasPriorHistoryForClimb(climbSent, [])).toBe(true);
    });

    it('falls back to the logbook when the climb has no counts', () => {
      const climb = makeClimb({ uuid: 'c1' });
      // Climb is created via makeClimb without userAscents / userAttempts.
      expect(hasPriorHistoryForClimb(climb, [])).toBe(false);
      expect(hasPriorHistoryForClimb(climb, [makeLogbookEntry({ climb_uuid: 'c1' })])).toBe(true);
      expect(hasPriorHistoryForClimb(climb, [makeLogbookEntry({ climb_uuid: 'other' })])).toBe(false);
    });
  });

  describe('layout', () => {
    it('renders the controls: grade in left section, stars + tries in right section', async () => {
      render(<QuickTickBar {...defaultProps} />);

      // Grade label only appears after the async useGradeFormat hook loads.
      const gradeLabel = await screen.findByTestId('quick-tick-grade');
      const rating = screen.getByTestId('quick-tick-rating');
      const attemptBtn = screen.getByTestId('quick-tick-attempt');

      // Grade is in the left section (separate from stars/tries for alignment).
      // Stars and tries share a parent (the Stack inside rightControls).
      expect(rating.parentElement).toBe(attemptBtn.parentElement);
      expect(gradeLabel.parentElement).not.toBe(rating.parentElement);

      // All three are present.
      expect(gradeLabel).toBeTruthy();
      expect(rating).toBeTruthy();
      expect(attemptBtn).toBeTruthy();
    });

    it('defaults the tries counter to 1 and exposes a "tries" byline for the user', () => {
      render(<QuickTickBar {...defaultProps} />);
      const attemptBtn = screen.getByTestId('quick-tick-attempt');
      // The top-line number (the "1" that must stay aligned with the other
      // row items) is rendered directly; the "tries" label sits beneath.
      expect(attemptBtn.textContent).toContain('1');
      expect(attemptBtn.textContent?.toLowerCase()).toContain('tries');
    });

    it('does not render the swipe hint inline — the hint lives above the bar as a transient toast', () => {
      render(<QuickTickBar {...defaultProps} />);
      expect(screen.queryByTestId('quick-tick-hint')).toBeNull();
    });
  });

  describe('save behaviour — history-aware default', () => {
    it('saves as flash with attemptCount 1 when the logbook is empty', async () => {
      vi.useFakeTimers();
      mockLogbookRef.current = [];
      const ref = React.createRef<QuickTickBarHandle>();
      render(<QuickTickBar ref={ref} {...defaultProps} />);

      await act(async () => {
        ref.current!.save();
      });

      expect(mockSaveTick).toHaveBeenCalledTimes(1);
      const call = mockSaveTick.mock.calls[0][0];
      expect(call.status).toBe('flash');
      expect(call.attemptCount).toBe(1);
      expect(call.climbUuid).toBe('climb-1');
      // Flash saves have a 300ms delay before calling onSave (for button pulse animation).
      await act(async () => {
        vi.advanceTimersByTime(300);
      });
      expect(defaultProps.onSave).toHaveBeenCalledTimes(1);
    });

    it('saves as send with attemptCount 1 when there is one prior log', async () => {
      mockLogbookRef.current = [makeLogbookEntry({ uuid: 'p1', climb_uuid: 'climb-1', angle: 40 })];
      const ref = React.createRef<QuickTickBarHandle>();
      render(<QuickTickBar ref={ref} {...defaultProps} />);

      await act(async () => {
        ref.current!.save();
      });

      const call = mockSaveTick.mock.calls[0][0];
      expect(call.status).toBe('send');
      expect(call.attemptCount).toBe(1);
    });

    it('still logs a single send row (attemptCount 1) when there are multiple prior logs', async () => {
      mockLogbookRef.current = [
        makeLogbookEntry({ uuid: 'p1', status: 'attempt' }),
        makeLogbookEntry({ uuid: 'p2', status: 'attempt' }),
        makeLogbookEntry({ uuid: 'p3', status: 'attempt' }),
      ];
      const ref = React.createRef<QuickTickBarHandle>();
      render(<QuickTickBar ref={ref} {...defaultProps} />);

      await act(async () => {
        ref.current!.save();
      });

      const call = mockSaveTick.mock.calls[0][0];
      expect(call.status).toBe('send');
      expect(call.attemptCount).toBe(1);
    });

    it('ignores logbook rows for other climbs when deciding flash vs send', async () => {
      mockLogbookRef.current = [makeLogbookEntry({ uuid: 'other-climb', climb_uuid: 'climb-other', angle: 40 })];
      const ref = React.createRef<QuickTickBarHandle>();
      render(<QuickTickBar ref={ref} {...defaultProps} />);

      await act(async () => {
        ref.current!.save();
      });

      const call = mockSaveTick.mock.calls[0][0];
      expect(call.status).toBe('flash');
      expect(call.attemptCount).toBe(1);
    });

    it('clicking the attempts counter opens the tries picker and does NOT save on its own', async () => {
      render(<QuickTickBar {...defaultProps} />);

      await act(async () => {
        screen.getByTestId('quick-tick-attempt').click();
      });

      // Picker should be open with options 1–99 available.
      expect(screen.getByRole('option', { name: '1 try' })).toBeTruthy();
      expect(screen.getByRole('option', { name: '99 tries' })).toBeTruthy();
      // Selecting a number is state only — no row is saved until the parent
      // calls ref.current.save().
      expect(mockSaveTick).not.toHaveBeenCalled();
    });

    it('uses the selected attempt count when saving via the ref handle', async () => {
      mockLogbookRef.current = [];
      const ref = React.createRef<QuickTickBarHandle>();
      render(<QuickTickBar ref={ref} {...defaultProps} />);

      // Open the tries picker and pick "3".
      await act(async () => {
        screen.getByTestId('quick-tick-attempt').click();
      });
      await act(async () => {
        screen.getByRole('option', { name: '3 tries' }).click();
      });

      // Now save via the imperative handle.
      await act(async () => {
        ref.current!.save();
      });

      expect(mockSaveTick).toHaveBeenCalledTimes(1);
      const call = mockSaveTick.mock.calls[0][0];
      // 3 tries without prior history is no longer a flash — it's a send.
      expect(call.status).toBe('send');
      expect(call.attemptCount).toBe(3);
    });

    it('uses userAscents on the climb to default to send without touching the logbook', async () => {
      // Logbook is intentionally empty — the fast path should look at the
      // climb's own counts and still treat this as a send.
      mockLogbookRef.current = [];
      const climbWithHistory = makeClimb({ userAscents: 2, userAttempts: 0 });

      const ref = React.createRef<QuickTickBarHandle>();
      render(<QuickTickBar ref={ref} {...defaultProps} currentClimb={climbWithHistory} />);

      await act(async () => {
        ref.current!.save();
      });

      const call = mockSaveTick.mock.calls[0][0];
      expect(call.status).toBe('send');
      expect(call.attemptCount).toBe(1);
    });

    it('uses userAttempts on the climb to default to send without touching the logbook', async () => {
      mockLogbookRef.current = [];
      const climbWithAttempts = makeClimb({ userAscents: 0, userAttempts: 1 });

      const ref = React.createRef<QuickTickBarHandle>();
      render(<QuickTickBar ref={ref} {...defaultProps} currentClimb={climbWithAttempts} />);

      await act(async () => {
        ref.current!.save();
      });

      const call = mockSaveTick.mock.calls[0][0];
      expect(call.status).toBe('send');
      expect(call.attemptCount).toBe(1);
    });

    it('reflects the quality rating in the save payload', async () => {
      const ref = React.createRef<QuickTickBarHandle>();
      render(<QuickTickBar ref={ref} {...defaultProps} />);

      // Open the star picker and pick 3 stars.
      await act(async () => {
        screen.getByTestId('quick-tick-rating').click();
      });
      await act(async () => {
        screen.getByRole('option', { name: '3 stars' }).click();
      });

      await act(async () => {
        ref.current!.save();
      });

      const call = mockSaveTick.mock.calls[0][0];
      expect(call.quality).toBe(3);
    });

    it('does not call onSave when saveTick rejects and leaves the bar mounted', async () => {
      mockSaveTick.mockRejectedValueOnce(new Error('network down'));
      const ref = React.createRef<QuickTickBarHandle>();
      render(<QuickTickBar ref={ref} {...defaultProps} />);

      await act(async () => {
        ref.current!.save();
      });

      expect(mockSaveTick).toHaveBeenCalledTimes(1);
      expect(defaultProps.onSave).not.toHaveBeenCalled();
      // Bar should still be mounted and usable for a retry.
      expect(screen.getByTestId('quick-tick-bar')).toBeTruthy();
    });
  });

  describe('null currentClimb on mount', () => {
    it('renders without crashing when currentClimb is initially null', () => {
      render(<QuickTickBar {...defaultProps} currentClimb={null} />);
      expect(screen.getByTestId('quick-tick-bar')).toBeTruthy();
    });

    it('does not call saveTick when currentClimb is null and save is called', async () => {
      const ref = React.createRef<QuickTickBarHandle>();
      render(<QuickTickBar ref={ref} {...defaultProps} currentClimb={null} />);

      await act(async () => {
        ref.current!.save();
      });

      expect(mockSaveTick).not.toHaveBeenCalled();
      expect(defaultProps.onSave).not.toHaveBeenCalled();
    });

    it('defers the snapshot until a non-null climb arrives', async () => {
      const climb = makeClimb({ uuid: 'deferred-climb' });
      const ref = React.createRef<QuickTickBarHandle>();
      const { rerender } = render(<QuickTickBar ref={ref} {...defaultProps} currentClimb={null} />);

      // Snapshot should be absent — save should be a no-op.
      await act(async () => {
        ref.current!.save();
      });
      expect(mockSaveTick).not.toHaveBeenCalled();

      // Now provide a climb — the snapshot should be initialized.
      rerender(<QuickTickBar ref={ref} {...defaultProps} currentClimb={climb} />);

      await act(async () => {
        ref.current!.save();
      });

      expect(mockSaveTick).toHaveBeenCalledTimes(1);
      expect(mockSaveTick.mock.calls[0][0].climbUuid).toBe('deferred-climb');
    });
  });

  describe('climb snapshot', () => {
    it('keeps ticking the original climb even when currentClimb prop changes', async () => {
      const originalClimb = makeClimb({ uuid: 'original-climb' });
      const newClimb = makeClimb({ uuid: 'new-climb' });

      // Original climb has no prior history.
      // The new climb has 5 prior rows — if the component ever resolved the
      // "live" props instead of its snapshot, we would see send/6 below.
      mockLogbookRef.current = [
        makeLogbookEntry({ uuid: 'n1', climb_uuid: 'new-climb' }),
        makeLogbookEntry({ uuid: 'n2', climb_uuid: 'new-climb' }),
        makeLogbookEntry({ uuid: 'n3', climb_uuid: 'new-climb' }),
        makeLogbookEntry({ uuid: 'n4', climb_uuid: 'new-climb' }),
        makeLogbookEntry({ uuid: 'n5', climb_uuid: 'new-climb' }),
      ];

      const ref = React.createRef<QuickTickBarHandle>();
      const { rerender } = render(<QuickTickBar ref={ref} {...defaultProps} currentClimb={originalClimb} />);

      // Simulate another party member advancing the queue mid-tick.
      rerender(<QuickTickBar ref={ref} {...defaultProps} currentClimb={newClimb} />);

      await act(async () => {
        ref.current!.save();
      });

      const call = mockSaveTick.mock.calls[0][0];
      expect(call.climbUuid).toBe('original-climb');
      expect(call.status).toBe('flash');
      expect(call.attemptCount).toBe(1);
    });
  });

  // Swipe-to-dismiss is handled by the parent queue-control-bar, not QuickTickBar.

  describe('controlled comment prop', () => {
    it('forwards the comment prop in the save payload', async () => {
      const ref = React.createRef<QuickTickBarHandle>();
      render(<QuickTickBar ref={ref} {...defaultProps} comment="sick send" />);

      await act(async () => {
        ref.current!.save();
      });

      expect(mockSaveTick).toHaveBeenCalledTimes(1);
      expect(mockSaveTick.mock.calls[0][0].comment).toBe('sick send');
    });
  });

  describe('displayedGrades — all grades always shown', () => {
    // All grades are always shown in the horizontally-scrollable picker,
    // regardless of the climb's difficulty.

    it('shows all 24 grades when the climb difficulty does not match any grade name', async () => {
      render(<QuickTickBar {...defaultProps} />);
      fireEvent.click(await screen.findByTestId('quick-tick-grade'));

      const items = screen.getAllByRole('option');
      // 24 grade options + 1 "—" (clear) option
      expect(items).toHaveLength(25);
    });

    it('shows all 24 grades when the climb has no difficulty set', async () => {
      const climb = makeClimb({ difficulty: undefined });
      render(<QuickTickBar {...defaultProps} currentClimb={climb} />);
      fireEvent.click(await screen.findByTestId('quick-tick-grade'));

      const items = screen.getAllByRole('option');
      expect(items).toHaveLength(25);
    });

    it('shows all 24 grades even when the climb has a matched difficulty', async () => {
      const climb = makeClimb({ difficulty: '6c/V5' });
      render(<QuickTickBar {...defaultProps} currentClimb={climb} />);
      fireEvent.click(await screen.findByTestId('quick-tick-grade'));

      const items = screen.getAllByRole('option');
      expect(items).toHaveLength(25);
    });
  });

  describe('grade picker selection', () => {
    it('shows consensus grade as focused but not selected when the picker opens', async () => {
      const climb = makeClimb({ difficulty: '6c/V5' });
      render(<QuickTickBar {...defaultProps} currentClimb={climb} />);

      const gradeEl = await screen.findByTestId('quick-tick-grade');
      await act(async () => {
        fireEvent.click(gradeEl);
      });

      await waitFor(() => {
        const items = screen.getAllByRole('option');
        // Only the "—" (clear) option is selected since no grade is chosen by default
        const selectedItems = items.filter((el) => el.getAttribute('aria-selected') === 'true');
        expect(selectedItems).toHaveLength(1);
        expect(selectedItems[0].textContent).toBe('—');
        // The consensus grade should be labeled as such but not selected
        const consensusItem = items.find((el) => el.getAttribute('aria-label') === 'V5 (consensus)');
        expect(consensusItem).toBeTruthy();
        expect(consensusItem?.getAttribute('aria-selected')).toBe('false');
      });
    });

    it('does not mark any grade as selected when the climb has no matched difficulty', async () => {
      render(<QuickTickBar {...defaultProps} />);

      const gradeEl = await screen.findByTestId('quick-tick-grade');
      await act(async () => {
        fireEvent.click(gradeEl);
      });

      await waitFor(() => {
        const items = screen.getAllByRole('option');
        // Only the "—" clear option is selected (currentGradeId is undefined)
        const selectedItems = items.filter((el) => el.getAttribute('aria-selected') === 'true');
        expect(selectedItems).toHaveLength(1);
        expect(selectedItems[0].textContent).toBe('—');
      });
    });
  });

  describe('picker panel animation', () => {
    it('keeps picker content mounted during 200ms collapse animation', async () => {
      vi.useFakeTimers();

      render(<QuickTickBar {...defaultProps} />);

      // Open the star picker.
      await act(async () => {
        screen.getByTestId('quick-tick-rating').click();
      });

      // Star picker should be visible.
      expect(screen.getByRole('listbox', { name: 'Star rating' })).toBeTruthy();

      // Click stars again to close the picker.
      await act(async () => {
        screen.getByTestId('quick-tick-rating').click();
      });

      // Picker content should still be mounted (collapse animation in progress).
      expect(screen.queryByRole('listbox', { name: 'Star rating' })).toBeTruthy();

      // Advance past the 200ms animation timeout.
      await act(async () => {
        vi.advanceTimersByTime(200);
      });

      // Now the picker content should be unmounted.
      expect(screen.queryByRole('listbox', { name: 'Star rating' })).toBeNull();
    });
  });

  describe('comment focus collapses pickers', () => {
    it('collapses an open picker when the comment slot gains focus', async () => {
      const commentInput = <input data-testid="comment-input" />;
      render(<QuickTickBar {...defaultProps} commentSlot={commentInput} />);

      // Open the star picker.
      await act(async () => {
        screen.getByTestId('quick-tick-rating').click();
      });

      // Star picker should be visible.
      expect(screen.getByRole('listbox', { name: 'Star rating' })).toBeTruthy();

      // Focus the comment input — should collapse pickers.
      await act(async () => {
        fireEvent.focus(screen.getByTestId('comment-input'));
      });

      // The expandedControl should now be null. Wait for collapse.
      // The picker panel CSS class should no longer include the expanded state.
      // The aria-expanded on the rating button should be false.
      expect(screen.getByTestId('quick-tick-rating').getAttribute('aria-expanded')).toBe('false');
    });
  });

  describe('star picker clear button', () => {
    it('has a "No rating" option that resets quality to null', async () => {
      const ref = React.createRef<QuickTickBarHandle>();
      render(<QuickTickBar ref={ref} {...defaultProps} />);

      // Open star picker and pick 4 stars.
      await act(async () => {
        screen.getByTestId('quick-tick-rating').click();
      });
      await act(async () => {
        screen.getByRole('option', { name: '4 stars' }).click();
      });

      // Re-open and pick "No rating".
      await act(async () => {
        screen.getByTestId('quick-tick-rating').click();
      });
      await act(async () => {
        screen.getByRole('option', { name: 'No rating' }).click();
      });

      // Save and verify quality is undefined (not set).
      await act(async () => {
        ref.current!.save();
      });

      const call = mockSaveTick.mock.calls[0][0];
      expect(call.quality).toBeUndefined();
    });
  });

  describe('tries picker range', () => {
    it('renders 99 options in the tries picker', async () => {
      render(<QuickTickBar {...defaultProps} />);

      await act(async () => {
        screen.getByTestId('quick-tick-attempt').click();
      });

      const listbox = screen.getByRole('listbox', { name: 'Attempt count' });
      const options = listbox.querySelectorAll('[role="option"]');
      expect(options).toHaveLength(99);
    });

    it('supports selecting a high attempt count', async () => {
      const ref = React.createRef<QuickTickBarHandle>();
      render(<QuickTickBar ref={ref} {...defaultProps} />);

      await act(async () => {
        screen.getByTestId('quick-tick-attempt').click();
      });
      await act(async () => {
        screen.getByRole('option', { name: '50 tries' }).click();
      });

      await act(async () => {
        ref.current!.save();
      });

      const call = mockSaveTick.mock.calls[0][0];
      expect(call.attemptCount).toBe(50);
      expect(call.status).toBe('send');
    });
  });

  describe('grade picker clear button', () => {
    it('has a "Clear grade override" option that resets difficulty', async () => {
      const ref = React.createRef<QuickTickBarHandle>();
      const climb = makeClimb({ difficulty: '6c/V5' });
      render(<QuickTickBar ref={ref} {...defaultProps} currentClimb={climb} />);

      // Open grade picker and pick a different grade.
      await act(async () => {
        fireEvent.click(await screen.findByTestId('quick-tick-grade'));
      });
      await act(async () => {
        screen.getByRole('option', { name: 'Clear grade override' }).click();
      });

      // Save and verify difficulty is undefined (reset to climb's default).
      await act(async () => {
        ref.current!.save();
      });

      const call = mockSaveTick.mock.calls[0][0];
      expect(call.difficulty).toBeUndefined();
    });
  });

  describe('picker toggle behaviour', () => {
    it('clicking the same control button closes its picker', async () => {
      render(<QuickTickBar {...defaultProps} />);

      // Open star picker.
      await act(async () => {
        screen.getByTestId('quick-tick-rating').click();
      });
      expect(screen.getByTestId('quick-tick-rating').getAttribute('aria-expanded')).toBe('true');

      // Click the same button again — should close.
      await act(async () => {
        screen.getByTestId('quick-tick-rating').click();
      });
      expect(screen.getByTestId('quick-tick-rating').getAttribute('aria-expanded')).toBe('false');
    });

    it('clicking a different control switches the picker', async () => {
      render(<QuickTickBar {...defaultProps} />);

      // Open star picker.
      await act(async () => {
        screen.getByTestId('quick-tick-rating').click();
      });
      expect(screen.getByTestId('quick-tick-rating').getAttribute('aria-expanded')).toBe('true');
      expect(screen.getByTestId('quick-tick-attempt').getAttribute('aria-expanded')).toBe('false');

      // Click the tries button — should switch to tries picker.
      await act(async () => {
        screen.getByTestId('quick-tick-attempt').click();
      });
      expect(screen.getByTestId('quick-tick-rating').getAttribute('aria-expanded')).toBe('false');
      expect(screen.getByTestId('quick-tick-attempt').getAttribute('aria-expanded')).toBe('true');

      // Tries picker should be visible, star picker should not.
      expect(screen.getByRole('listbox', { name: 'Attempt count' })).toBeTruthy();
      expect(screen.queryByRole('listbox', { name: 'Star rating' })).toBeNull();
    });
  });

  describe('double-save prevention', () => {
    it('second save is blocked after the first save triggers a re-render with isSaving=true', async () => {
      // Make saveTick hang until we resolve it manually.
      let resolveSave: (() => void) | undefined;
      mockSaveTick.mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            resolveSave = resolve;
          }),
      );

      const ref = React.createRef<QuickTickBarHandle>();
      render(<QuickTickBar ref={ref} {...defaultProps} />);

      // First save — starts the async operation and sets isSaving = true.
      await act(async () => {
        ref.current!.save();
      });

      expect(mockSaveTick).toHaveBeenCalledTimes(1);

      // Second save — isSaving is now true after re-render, so this is a no-op.
      await act(async () => {
        ref.current!.save();
      });

      expect(mockSaveTick).toHaveBeenCalledTimes(1);

      // Resolve the pending save.
      await act(async () => {
        resolveSave!();
      });
    });
  });

  describe('onIsFlashChange callback', () => {
    it('fires with true on mount when logbook is empty and attemptCount defaults to 1', () => {
      mockLogbookRef.current = [];
      const onIsFlashChange = vi.fn();
      render(<QuickTickBar {...defaultProps} onIsFlashChange={onIsFlashChange} />);

      expect(onIsFlashChange).toHaveBeenCalledWith(true);
    });

    it('fires with false on mount when the logbook has prior history for the climb', () => {
      mockLogbookRef.current = [makeLogbookEntry({ uuid: 'p1', climb_uuid: 'climb-1', angle: 40 })];
      const onIsFlashChange = vi.fn();
      render(<QuickTickBar {...defaultProps} onIsFlashChange={onIsFlashChange} />);

      expect(onIsFlashChange).toHaveBeenCalledWith(false);
    });

    it('fires with false on mount when the climb has userAscents > 0', () => {
      mockLogbookRef.current = [];
      const climbWithHistory = makeClimb({ userAscents: 1, userAttempts: 0 });
      const onIsFlashChange = vi.fn();
      render(<QuickTickBar {...defaultProps} currentClimb={climbWithHistory} onIsFlashChange={onIsFlashChange} />);

      expect(onIsFlashChange).toHaveBeenCalledWith(false);
    });

    it('fires with false on mount when the climb has userAttempts > 0', () => {
      mockLogbookRef.current = [];
      const climbWithAttempts = makeClimb({ userAscents: 0, userAttempts: 3 });
      const onIsFlashChange = vi.fn();
      render(<QuickTickBar {...defaultProps} currentClimb={climbWithAttempts} onIsFlashChange={onIsFlashChange} />);

      expect(onIsFlashChange).toHaveBeenCalledWith(false);
    });

    it('transitions from true to false when attemptCount changes from 1 to 2', async () => {
      mockLogbookRef.current = [];
      const onIsFlashChange = vi.fn();
      render(<QuickTickBar {...defaultProps} onIsFlashChange={onIsFlashChange} />);

      // Initially flash
      expect(onIsFlashChange).toHaveBeenLastCalledWith(true);

      // Open tries picker and select 2
      await act(async () => {
        screen.getByTestId('quick-tick-attempt').click();
      });
      await act(async () => {
        screen.getByRole('option', { name: '2 tries' }).click();
      });

      expect(onIsFlashChange).toHaveBeenLastCalledWith(false);
    });

    it('transitions back to true when attemptCount changes back to 1', async () => {
      mockLogbookRef.current = [];
      const onIsFlashChange = vi.fn();
      render(<QuickTickBar {...defaultProps} onIsFlashChange={onIsFlashChange} />);

      // Change to 2 tries
      await act(async () => {
        screen.getByTestId('quick-tick-attempt').click();
      });
      await act(async () => {
        screen.getByRole('option', { name: '2 tries' }).click();
      });
      expect(onIsFlashChange).toHaveBeenLastCalledWith(false);

      // Change back to 1 try
      await act(async () => {
        screen.getByTestId('quick-tick-attempt').click();
      });
      await act(async () => {
        screen.getByRole('option', { name: '1 try' }).click();
      });
      expect(onIsFlashChange).toHaveBeenLastCalledWith(true);
    });

    it('does not fire when currentClimb is null (no tickTarget)', () => {
      const onIsFlashChange = vi.fn();
      render(<QuickTickBar {...defaultProps} currentClimb={null} onIsFlashChange={onIsFlashChange} />);

      // isFlash is false when tickTarget is null, so it fires with false
      expect(onIsFlashChange).toHaveBeenCalledWith(false);
    });

    it('does not crash when onIsFlashChange is not provided', () => {
      mockLogbookRef.current = [];
      // Should not throw
      expect(() => render(<QuickTickBar {...defaultProps} />)).not.toThrow();
    });
  });

  describe('onAscentTypeChange callback', () => {
    it('calls onAscentTypeChange when ascent type changes', async () => {
      mockLogbookRef.current = [];
      const onAscentTypeChange = vi.fn();
      render(<QuickTickBar {...defaultProps} onAscentTypeChange={onAscentTypeChange} />);

      // On mount with no prior history and 1 try, inferred type is flash.
      expect(onAscentTypeChange).toHaveBeenCalledWith('flash');

      // Open tries picker and select 2 — should change ascent type to send.
      await act(async () => {
        screen.getByTestId('quick-tick-attempt').click();
      });
      await act(async () => {
        screen.getByRole('option', { name: '2 tries' }).click();
      });

      expect(onAscentTypeChange).toHaveBeenCalledWith('send');
    });

    it('reports send when the climb already has userAscents on mount', () => {
      mockLogbookRef.current = [];
      const onAscentTypeChange = vi.fn();
      const climbWithHistory = makeClimb({ userAscents: 1, userAttempts: 0 });
      render(
        <QuickTickBar {...defaultProps} currentClimb={climbWithHistory} onAscentTypeChange={onAscentTypeChange} />,
      );
      expect(onAscentTypeChange).toHaveBeenLastCalledWith('send');
    });

    it('reports send when the climb already has userAttempts on mount', () => {
      mockLogbookRef.current = [];
      const onAscentTypeChange = vi.fn();
      const climbWithAttempts = makeClimb({ userAscents: 0, userAttempts: 2 });
      render(
        <QuickTickBar {...defaultProps} currentClimb={climbWithAttempts} onAscentTypeChange={onAscentTypeChange} />,
      );
      expect(onAscentTypeChange).toHaveBeenLastCalledWith('send');
    });

    it('reports send when the logbook contains a prior entry for this climb', () => {
      mockLogbookRef.current = [makeLogbookEntry({ uuid: 'p1', climb_uuid: 'climb-1', angle: 40 })];
      const onAscentTypeChange = vi.fn();
      render(<QuickTickBar {...defaultProps} onAscentTypeChange={onAscentTypeChange} />);
      expect(onAscentTypeChange).toHaveBeenLastCalledWith('send');
    });
  });

  describe('expanded mode', () => {
    it('does not render save button in expanded mode', () => {
      const onExpandedChange = vi.fn();
      render(<QuickTickBar {...defaultProps} expanded onExpandedChange={onExpandedChange} />);

      // There should be no "Save tick" button in expanded mode.
      expect(screen.queryByRole('button', { name: /save tick/i })).toBeNull();
      // Also verify by text content.
      expect(screen.queryByText(/save tick/i)).toBeNull();
    });
  });

  describe('aria-expanded state', () => {
    it('toggles aria-expanded on the rating button', async () => {
      render(<QuickTickBar {...defaultProps} />);

      const ratingBtn = screen.getByTestId('quick-tick-rating');
      expect(ratingBtn.getAttribute('aria-expanded')).toBe('false');

      await act(async () => {
        ratingBtn.click();
      });
      expect(ratingBtn.getAttribute('aria-expanded')).toBe('true');

      await act(async () => {
        ratingBtn.click();
      });
      expect(ratingBtn.getAttribute('aria-expanded')).toBe('false');
    });

    it('toggles aria-expanded on the tries button', async () => {
      render(<QuickTickBar {...defaultProps} />);

      const triesBtn = screen.getByTestId('quick-tick-attempt');
      expect(triesBtn.getAttribute('aria-expanded')).toBe('false');

      await act(async () => {
        triesBtn.click();
      });
      expect(triesBtn.getAttribute('aria-expanded')).toBe('true');

      await act(async () => {
        triesBtn.click();
      });
      expect(triesBtn.getAttribute('aria-expanded')).toBe('false');
    });

    it('toggles aria-expanded on the grade button', async () => {
      render(<QuickTickBar {...defaultProps} />);

      const gradeBtn = await screen.findByTestId('quick-tick-grade');
      expect(gradeBtn.getAttribute('aria-expanded')).toBe('false');

      await act(async () => {
        gradeBtn.click();
      });
      expect(gradeBtn.getAttribute('aria-expanded')).toBe('true');

      await act(async () => {
        gradeBtn.click();
      });
      expect(gradeBtn.getAttribute('aria-expanded')).toBe('false');
    });
  });
});
