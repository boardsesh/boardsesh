import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import React from 'react';
import { render, screen, act } from '@testing-library/react';
import type { Angle, BoardDetails, BoardName, Climb } from '@/app/lib/types';
import type { LogbookEntry } from '@/app/hooks/use-logbook';
import { InlineListTickBar } from '../inline-list-tick-bar';
import { tFromCatalog } from '@/app/__test-helpers__/i18n-mock';

vi.mock('react-i18next', () => ({
  useTranslation: (ns?: string) => ({
    t: (key: string, options?: Record<string, unknown>) => tFromCatalog(ns, key, options),
    i18n: { language: 'en-US' },
  }),
  Trans: ({ children }: { children?: React.ReactNode }) => children ?? null,
}));

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

vi.mock('@/app/lib/tick-draft-db', () => ({
  loadTickDraft: vi.fn().mockResolvedValue(null),
  saveTickDraft: vi.fn(),
  clearTickDraft: vi.fn(),
}));

const mockFireConfetti = vi.fn();
vi.mock('@/app/hooks/use-confetti', () => ({
  useConfetti: () => mockFireConfetti,
}));

vi.mock('@/app/hooks/use-is-dark-mode', () => ({
  useIsDarkMode: () => false,
}));

vi.mock('@/app/hooks/use-grade-format', () => ({
  useGradeFormat: () => ({
    gradeFormat: 'v-grade',
    formatGrade: (g: string | null | undefined) => g ?? null,
    getGradeColor: vi.fn(),
    loaded: true,
  }),
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
    holdsData: [],
    edge_left: 0,
    edge_right: 0,
    edge_bottom: 0,
    edge_top: 0,
    boardHeight: 100,
    boardWidth: 100,
    ...overrides,
  } as BoardDetails;
}

const defaultProps = {
  climb: makeClimb(),
  angle: 40 as Angle,
  boardDetails: makeBoardDetails(),
  onClose: vi.fn(),
};

describe('InlineListTickBar', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLogbookRef.current = [];
    mockSaveTick.mockResolvedValue(undefined);
    defaultProps.onClose = vi.fn();
  });

  describe('visibility', () => {
    it('renders the tick bar wrapper when mounted', () => {
      const { container } = render(<InlineListTickBar {...defaultProps} />);
      const wrapper = container.firstElementChild;
      expect(wrapper).toBeTruthy();
      expect(wrapper?.className).toContain('tickBarWrapper');
    });
  });

  describe('controls when open', () => {
    it('renders the save (check) button with "Log ascent" label', () => {
      render(<InlineListTickBar {...defaultProps} />);
      expect(screen.getByRole('button', { name: 'Log ascent' })).toBeTruthy();
    });

    it('renders the attempt (X) button with "Log attempt" label', () => {
      render(<InlineListTickBar {...defaultProps} />);
      expect(screen.getByRole('button', { name: 'Log attempt' })).toBeTruthy();
    });

    it('renders the cancel button', () => {
      render(<InlineListTickBar {...defaultProps} />);
      expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy();
    });
  });

  describe('cancel button', () => {
    it('calls onClose when the cancel button is clicked', async () => {
      render(<InlineListTickBar {...defaultProps} />);

      await act(async () => {
        screen.getByRole('button', { name: 'Cancel' }).click();
      });

      expect(defaultProps.onClose).toHaveBeenCalledTimes(1);
    });
  });

  describe('save actions', () => {
    it('clicking the Log ascent button fires confetti and saves', async () => {
      vi.useFakeTimers();
      render(<InlineListTickBar {...defaultProps} />);

      await act(async () => {
        screen.getByRole('button', { name: 'Log ascent' }).click();
      });

      expect(mockFireConfetti).toHaveBeenCalledTimes(1);
      expect(mockSaveTick).toHaveBeenCalledTimes(1);
      const call = mockSaveTick.mock.calls[0][0];
      expect(call.status).toBe('flash');

      // Flash saves have a 300ms delay before calling onClose
      await act(async () => {
        vi.advanceTimersByTime(300);
      });
      expect(defaultProps.onClose).toHaveBeenCalledTimes(1);
      vi.useRealTimers();
    });

    // Confetti on attempts is intentional — it's a small celebration for logging
    // any climbing activity, encouraging users to keep trying. Matches queue control bar behavior.
    it('clicking the Log attempt button fires confetti and saves an attempt', async () => {
      render(<InlineListTickBar {...defaultProps} />);

      await act(async () => {
        screen.getByRole('button', { name: 'Log attempt' }).click();
      });

      expect(mockFireConfetti).toHaveBeenCalledTimes(1);
      expect(mockSaveTick).toHaveBeenCalledTimes(1);
      const call = mockSaveTick.mock.calls[0][0];
      expect(call.status).toBe('attempt');
      expect(defaultProps.onClose).toHaveBeenCalledTimes(1);
    });
  });

  describe('error handling', () => {
    it('calls onError when saveTick rejects', async () => {
      mockSaveTick.mockRejectedValue(new Error('fail'));
      const onError = vi.fn();

      render(<InlineListTickBar {...defaultProps} onError={onError} />);

      await act(async () => {
        screen.getByRole('button', { name: 'Log ascent' }).click();
      });

      // Wait for the rejected promise to propagate
      await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    });
  });

  describe('state reset on remount', () => {
    it('uses default state values on fresh mount', async () => {
      // Mount, unmount, remount — fresh mount should have default state
      const { unmount } = render(<InlineListTickBar {...defaultProps} />);
      unmount();
      render(<InlineListTickBar {...defaultProps} />);

      await act(async () => {
        screen.getByRole('button', { name: 'Log ascent' }).click();
      });

      const call = mockSaveTick.mock.calls[0][0];
      expect(call.attemptCount).toBe(1);
      expect(call.quality).toBeUndefined();
    });
  });
});
