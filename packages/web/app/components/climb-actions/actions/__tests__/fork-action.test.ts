import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { ForkAction } from '../fork-action';
import { constructCreateClimbUrl } from '@/app/lib/url-utils';
import type { ClimbActionProps } from '../../types';
import type { BoardDetails, Climb } from '@/app/lib/types';

// Mock dependencies before importing the module
vi.mock('@/app/lib/analytics', () => ({
  track: vi.fn(),
}));

vi.mock('next/link', () => ({
  default: vi.fn(({ children }: { children: React.ReactNode }) => children),
}));

vi.mock('@/app/lib/url-utils', () => ({
  constructCreateClimbUrl: vi.fn(() => '/mocked-fork-url'),
}));

vi.mock('@/app/theme/theme-config', () => ({
  themeTokens: {
    spacing: { 4: '16px' },
    typography: { fontSize: { base: '14px' } },
  },
}));

vi.mock('@mui/icons-material/CallSplitOutlined', () => ({
  default: () => 'CallSplitOutlinedIcon',
}));

vi.mock('@mui/icons-material/EditOutlined', () => ({
  default: () => 'EditOutlinedIcon',
}));

vi.mock('@mui/material/Button', () => ({
  default: ({ children }: { children?: React.ReactNode }) => children,
}));

vi.mock('../../action-tooltip', () => ({
  ActionTooltip: ({ children }: { children: React.ReactNode }) => children,
}));

const mockUseSession = vi.fn();
vi.mock('next-auth/react', () => ({
  useSession: () => mockUseSession(),
}));

function createTestClimb(overrides?: Partial<Climb>): Climb {
  return {
    uuid: 'test-uuid-123',
    name: 'Test Climb',
    setter_username: 'testuser',
    description: 'A test climb',
    frames: 'p1r12p2r13',
    angle: 40,
    ascensionist_count: 5,
    difficulty: '6a/V3',
    quality_average: '3.5',
    stars: 3,
    difficulty_error: '0.50',
    benchmark_difficulty: null,
    ...overrides,
  };
}

function createTestBoardDetails(overrides?: Partial<BoardDetails>): BoardDetails {
  return {
    board_name: 'kilter',
    layout_id: 1,
    size_id: 10,
    set_ids: '1,2',
    images_to_holds: {},
    holdsData: {},
    edge_left: 0,
    edge_right: 100,
    edge_bottom: 0,
    edge_top: 100,
    boardHeight: 100,
    boardWidth: 100,
    layout_name: 'Original',
    size_name: '12x12',
    size_description: 'Full Size',
    set_names: ['Standard', 'Extended'],
    ...overrides,
  } as BoardDetails;
}

function createTestProps(overrides?: Partial<ClimbActionProps>): ClimbActionProps {
  return {
    climb: createTestClimb(),
    boardDetails: createTestBoardDetails(),
    angle: 40,
    viewMode: 'icon',
    ...overrides,
  };
}

describe('ForkAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseSession.mockReturnValue({ data: null, status: 'unauthenticated', update: vi.fn() });
  });

  describe('availability', () => {
    it('returns available: false when board_name is moonboard', () => {
      const props = createTestProps({
        boardDetails: createTestBoardDetails({ board_name: 'moonboard' }),
      });
      const result = ForkAction(props);
      expect(result.available).toBe(false);
    });

    it('returns available: false when layout_name is missing', () => {
      const props = createTestProps({
        boardDetails: createTestBoardDetails({ layout_name: undefined }),
      });
      const result = ForkAction(props);
      expect(result.available).toBe(false);
    });

    it('returns available: false when size_name is missing', () => {
      const props = createTestProps({
        boardDetails: createTestBoardDetails({ size_name: undefined }),
      });
      const result = ForkAction(props);
      expect(result.available).toBe(false);
    });

    it('returns available: false when set_names is missing', () => {
      const props = createTestProps({
        boardDetails: createTestBoardDetails({ set_names: undefined }),
      });
      const result = ForkAction(props);
      expect(result.available).toBe(false);
    });

    it('returns available: true when board is not moonboard and all slug fields present', () => {
      const props = createTestProps();
      const result = ForkAction(props);
      expect(result.available).toBe(true);
    });

    it('returns available: true for tension board with all fields', () => {
      const props = createTestProps({
        boardDetails: createTestBoardDetails({ board_name: 'tension' }),
      });
      const result = ForkAction(props);
      expect(result.available).toBe(true);
    });
  });

  describe('URL construction', () => {
    it('calls constructCreateClimbUrl with correct params when available', () => {
      const props = createTestProps();
      ForkAction(props);

      expect(constructCreateClimbUrl).toHaveBeenCalledWith(
        'kilter',
        'Original',
        '12x12',
        'Full Size',
        ['Standard', 'Extended'],
        40,
        { frames: 'p1r12p2r13', name: 'Test Climb' },
      );
    });

    it('does not call constructCreateClimbUrl when not available', () => {
      const props = createTestProps({
        boardDetails: createTestBoardDetails({ board_name: 'moonboard' }),
      });
      ForkAction(props);

      expect(constructCreateClimbUrl).not.toHaveBeenCalled();
    });
  });

  describe('menuItem', () => {
    it('returns a non-disabled menuItem when available', () => {
      const props = createTestProps();
      const result = ForkAction(props);
      expect(result.menuItem.key).toBe('fork');
      expect(result.menuItem.disabled).toBeFalsy();
    });

    it('returns a disabled menuItem when not available', () => {
      const props = createTestProps({
        boardDetails: createTestBoardDetails({ board_name: 'moonboard' }),
      });
      const result = ForkAction(props);
      expect(result.menuItem.key).toBe('fork');
      expect(result.menuItem.disabled).toBe(true);
    });
  });

  describe('key', () => {
    it('always returns "fork" as key', () => {
      const props = createTestProps();
      const result = ForkAction(props);
      expect(result.key).toBe('fork');
    });
  });

  describe('edit mode for owned drafts', () => {
    it('shows Edit label when climb is a draft owned by the current user', () => {
      mockUseSession.mockReturnValue({
        data: { user: { id: 'user-123' }, expires: '' },
        status: 'authenticated',
        update: vi.fn(),
      });
      const props = createTestProps({
        climb: createTestClimb({ is_draft: true, userId: 'user-123' }),
      });
      const result = ForkAction(props);
      expect(result.menuItem.label).toBeDefined();
    });

    it('passes editClimbUuid when editing an owned draft', () => {
      mockUseSession.mockReturnValue({
        data: { user: { id: 'user-123' }, expires: '' },
        status: 'authenticated',
        update: vi.fn(),
      });
      const props = createTestProps({
        climb: createTestClimb({
          is_draft: true,
          userId: 'user-123',
          description: 'Draft description',
        }),
      });
      ForkAction(props);

      expect(constructCreateClimbUrl).toHaveBeenCalledWith(
        'kilter',
        'Original',
        '12x12',
        'Full Size',
        ['Standard', 'Extended'],
        40,
        {
          frames: 'p1r12p2r13',
          name: 'Test Climb',
          description: 'Draft description',
          editClimbUuid: 'test-uuid-123',
        },
      );
    });

    it('shows Fork (not Edit) for drafts not owned by the current user', () => {
      mockUseSession.mockReturnValue({
        data: { user: { id: 'different-user' }, expires: '' },
        status: 'authenticated',
        update: vi.fn(),
      });
      const props = createTestProps({
        climb: createTestClimb({ is_draft: true, userId: 'user-123' }),
      });
      ForkAction(props);

      // Should be called with fork params (no editClimbUuid)
      expect(constructCreateClimbUrl).toHaveBeenCalledWith(
        'kilter',
        'Original',
        '12x12',
        'Full Size',
        ['Standard', 'Extended'],
        40,
        { frames: 'p1r12p2r13', name: 'Test Climb' },
      );
    });

    it('shows Fork for drafts when user is not authenticated', () => {
      mockUseSession.mockReturnValue({
        data: null,
        status: 'unauthenticated',
        update: vi.fn(),
      });
      const props = createTestProps({
        climb: createTestClimb({ is_draft: true, userId: 'user-123' }),
      });
      ForkAction(props);

      expect(constructCreateClimbUrl).toHaveBeenCalledWith(
        'kilter',
        'Original',
        '12x12',
        'Full Size',
        ['Standard', 'Extended'],
        40,
        { frames: 'p1r12p2r13', name: 'Test Climb' },
      );
    });

    it('shows Fork for non-draft climbs even if owned by current user', () => {
      mockUseSession.mockReturnValue({
        data: { user: { id: 'user-123' }, expires: '' },
        status: 'authenticated',
        update: vi.fn(),
      });
      const props = createTestProps({
        climb: createTestClimb({ is_draft: false, userId: 'user-123' }),
      });
      ForkAction(props);

      expect(constructCreateClimbUrl).toHaveBeenCalledWith(
        'kilter',
        'Original',
        '12x12',
        'Full Size',
        ['Standard', 'Extended'],
        40,
        { frames: 'p1r12p2r13', name: 'Test Climb' },
      );
    });
  });
});
