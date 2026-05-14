import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import React from 'react';
import { render, screen } from '@testing-library/react';
import type { Angle, BoardDetails, BoardName, Climb } from '@/app/lib/types';
import type { LogbookEntry } from '@boardsesh/board-react';
import { TickButton } from '../tick-button';

// --- Mocks (must be hoisted before imports of the component under test) ---

const mockLogbookRef: { current: LogbookEntry[] } = { current: [] };
const mockIsAuthenticated = { current: true };

vi.mock('../../board-provider/board-provider-context', () => ({
  useBoardProvider: () => ({
    saveTick: vi.fn(),
    logbook: mockLogbookRef.current,
    boardName: 'kilter' as BoardName,
    isAuthenticated: mockIsAuthenticated.current,
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

vi.mock('@/app/hooks/use-always-tick-in-app', () => ({
  useAlwaysTickInApp: () => ({
    alwaysUseApp: false,
    loaded: true,
    enableAlwaysUseApp: vi.fn(),
  }),
}));

vi.mock('../../providers/auth-modal-provider', () => ({
  useAuthModal: () => ({
    openAuthModal: vi.fn(),
  }),
}));

vi.mock('../log-ascent-drawer', () => ({
  LogAscentDrawer: () => null,
}));

vi.mock('../../swipeable-drawer/swipeable-drawer', () => ({
  default: () => null,
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

const defaultProps = {
  currentClimb: makeClimb(),
  angle: 40 as Angle,
  boardDetails: makeBoardDetails(),
  onActivateTickBar: vi.fn(),
  onTickSave: vi.fn(),
  tickBarActive: false,
  isFlash: false,
};

describe('TickButton', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLogbookRef.current = [];
    mockIsAuthenticated.current = true;
  });

  describe('icon rendering', () => {
    it('renders CheckOutlined when tickBarActive and isFlash is false', () => {
      const { container } = render(<TickButton {...defaultProps} tickBarActive isFlash={false} />);
      const svg = container.querySelector('#button-tick svg');
      expect(svg?.getAttribute('data-testid')).toBe('CheckOutlinedIcon');
    });

    it('renders ElectricBoltOutlined when tickBarActive and isFlash is true', () => {
      const { container } = render(<TickButton {...defaultProps} tickBarActive isFlash />);
      const svg = container.querySelector('#button-tick svg');
      expect(svg?.getAttribute('data-testid')).toBe('ElectricBoltOutlinedIcon');
    });

    it('renders CheckOutlined when tickBarActive is false', () => {
      const { container } = render(<TickButton {...defaultProps} tickBarActive={false} isFlash />);
      const svg = container.querySelector('#button-tick svg');
      expect(svg?.getAttribute('data-testid')).toBe('CheckOutlinedIcon');
    });

    it('renders CheckOutlined when isFlash is undefined and not active', () => {
      const { container } = render(<TickButton {...defaultProps} tickBarActive={false} isFlash={undefined} />);
      const svg = container.querySelector('#button-tick svg');
      expect(svg?.getAttribute('data-testid')).toBe('CheckOutlinedIcon');
    });

    it('renders person-falling icon and "attempt" label when ascentType is attempt', () => {
      const { container } = render(<TickButton {...defaultProps} tickBarActive ascentType="attempt" />);
      const svg = container.querySelector('#button-tick svg');
      expect(svg?.getAttribute('data-testid')).toBe('PersonFallingIcon');
      expect(screen.getByText('attempt')).toBeTruthy();
    });

    it('renders flash icon and "flash" label when ascentType is flash', () => {
      const { container } = render(<TickButton {...defaultProps} tickBarActive ascentType="flash" />);
      const svg = container.querySelector('#button-tick svg');
      expect(svg?.getAttribute('data-testid')).toBe('ElectricBoltOutlinedIcon');
      expect(screen.getByText('flash')).toBeTruthy();
    });

    it('renders check icon and "tick" label when ascentType is send', () => {
      const { container } = render(<TickButton {...defaultProps} tickBarActive ascentType="send" />);
      const svg = container.querySelector('#button-tick svg');
      expect(svg?.getAttribute('data-testid')).toBe('CheckOutlinedIcon');
      expect(screen.getByText('tick')).toBeTruthy();
    });

    it('renders flash icon when isFlash is true and no ascentType', () => {
      const { container } = render(<TickButton {...defaultProps} tickBarActive isFlash ascentType={undefined} />);
      const svg = container.querySelector('#button-tick svg');
      expect(svg?.getAttribute('data-testid')).toBe('ElectricBoltOutlinedIcon');
      expect(screen.getByText('flash')).toBeTruthy();
    });

    it('renders check icon when isFlash is false and no ascentType', () => {
      const { container } = render(
        <TickButton {...defaultProps} tickBarActive isFlash={false} ascentType={undefined} />,
      );
      const svg = container.querySelector('#button-tick svg');
      expect(svg?.getAttribute('data-testid')).toBe('CheckOutlinedIcon');
      expect(screen.getByText('tick')).toBeTruthy();
    });
  });

  describe('label rendering', () => {
    it('shows "tick" label when tickBarActive and not flash', () => {
      render(<TickButton {...defaultProps} tickBarActive isFlash={false} />);
      expect(screen.getByText('tick')).toBeTruthy();
    });

    it('shows "flash" label when tickBarActive and isFlash', () => {
      render(<TickButton {...defaultProps} tickBarActive isFlash />);
      expect(screen.getByText('flash')).toBeTruthy();
    });

    it('does not show a label when tickBarActive is false', () => {
      render(<TickButton {...defaultProps} tickBarActive={false} isFlash={false} />);
      expect(screen.queryByText('tick')).toBeNull();
      expect(screen.queryByText('flash')).toBeNull();
    });
  });

  describe('accessibility', () => {
    it('has aria-label "Save tick" when tickBarActive', () => {
      render(<TickButton {...defaultProps} tickBarActive isFlash />);
      const button = document.getElementById('button-tick');
      expect(button?.getAttribute('aria-label')).toBe('Save tick');
    });

    it('has aria-label "Save tick" when tickBarActive and not isFlash', () => {
      render(<TickButton {...defaultProps} tickBarActive isFlash={false} />);
      const button = document.getElementById('button-tick');
      expect(button?.getAttribute('aria-label')).toBe('Save tick');
    });

    it('has aria-label "Log ascent" when tickBarActive is false', () => {
      render(<TickButton {...defaultProps} tickBarActive={false} />);
      const button = document.getElementById('button-tick');
      expect(button?.getAttribute('aria-label')).toBe('Log ascent');
    });
  });

  describe('styling', () => {
    it('renders the tick button when tickBarActive and isFlash', () => {
      render(<TickButton {...defaultProps} tickBarActive isFlash />);
      const button = document.getElementById('button-tick');
      expect(button).toBeTruthy();
      // MUI applies styles via CSS classes — verify the class list is non-trivial
      expect(button!.className).toContain('MuiIconButton');
    });

    it('renders the tick button when tickBarActive and not isFlash', () => {
      render(<TickButton {...defaultProps} tickBarActive isFlash={false} />);
      const button = document.getElementById('button-tick');
      expect(button).toBeTruthy();
      expect(button!.className).toContain('MuiIconButton');
    });

    it('renders the tick button when tickBarActive is false', () => {
      render(<TickButton {...defaultProps} tickBarActive={false} />);
      const button = document.getElementById('button-tick');
      expect(button).toBeTruthy();
      expect(button!.className).toContain('MuiIconButton');
    });
  });

  describe('badge', () => {
    it('shows badge count from filtered logbook', () => {
      mockLogbookRef.current = [
        {
          uuid: 'log-1',
          climb_uuid: 'climb-1',
          angle: 40,
          is_mirror: false,
          tries: 1,
          quality: null,
          difficulty: null,
          effectiveDifficulty: null,
          comment: '',
          climbed_at: '2025-01-01',
          is_ascent: true,
          status: 'flash',
          upvotes: 0,
          downvotes: 0,
          commentCount: 0,
        },
        {
          uuid: 'log-2',
          climb_uuid: 'climb-1',
          angle: 40,
          is_mirror: false,
          tries: 2,
          quality: null,
          difficulty: null,
          effectiveDifficulty: null,
          comment: '',
          climbed_at: '2025-01-02',
          is_ascent: false,
          status: 'attempt',
          upvotes: 0,
          downvotes: 0,
          commentCount: 0,
        },
      ];
      render(<TickButton {...defaultProps} />);
      const badge = document.querySelector('.MuiBadge-badge');
      expect(badge?.textContent).toBe('2');
    });

    it('does not show badge when logbook is empty', () => {
      mockLogbookRef.current = [];
      render(<TickButton {...defaultProps} />);
      const badge = document.querySelector('.MuiBadge-badge');
      // MUI hides badge with invisible class when content is 0
      expect(badge?.classList.contains('MuiBadge-invisible')).toBe(true);
    });
  });
});
