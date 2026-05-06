import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { ViewDetailsAction } from '../view-details-action';
import { getContextAwareClimbViewUrl } from '@/app/lib/url-utils';
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
  getContextAwareClimbViewUrl: vi.fn(() => '/context-aware-url'),
}));

vi.mock('@/app/theme/theme-config', () => ({
  themeTokens: {
    spacing: { 4: '16px' },
    typography: { fontSize: { base: '14px' } },
  },
}));

vi.mock('@mui/icons-material/InfoOutlined', () => ({
  default: () => 'InfoOutlinedIcon',
}));

vi.mock('@mui/material/Button', () => ({
  default: ({ children }: { children?: React.ReactNode }) => children,
}));

vi.mock('../../action-tooltip', () => ({
  ActionTooltip: ({ children }: { children: React.ReactNode }) => children,
}));

function createTestClimb(overrides?: Partial<Climb>): Climb {
  return {
    uuid: 'test-uuid-456',
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

describe('ViewDetailsAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('always available', () => {
    it('always returns available: true', () => {
      const props = createTestProps();
      const result = ViewDetailsAction(props);
      expect(result.available).toBe(true);
    });

    it('returns available: true even without slug fields', () => {
      const props = createTestProps({
        boardDetails: createTestBoardDetails({
          layout_name: undefined,
          size_name: undefined,
          set_names: undefined,
        }),
      });
      const result = ViewDetailsAction(props);
      expect(result.available).toBe(true);
    });
  });

  describe('URL construction strategy', () => {
    it('delegates URL generation to getContextAwareClimbViewUrl', () => {
      const props = createTestProps();
      ViewDetailsAction(props);

      expect(getContextAwareClimbViewUrl).toHaveBeenCalledWith(
        '',
        props.boardDetails,
        40,
        'test-uuid-456',
        'Test Climb',
      );
    });

    it('passes current pathname when provided', () => {
      const props = createTestProps({
        currentPathname: '/b/my-board/40/list',
      });
      ViewDetailsAction(props);

      expect(getContextAwareClimbViewUrl).toHaveBeenCalledWith(
        '/b/my-board/40/list',
        props.boardDetails,
        40,
        'test-uuid-456',
        'Test Climb',
      );
    });
  });

  describe('key', () => {
    it('always returns "viewDetails" as key', () => {
      const props = createTestProps();
      const result = ViewDetailsAction(props);
      expect(result.key).toBe('viewDetails');
    });
  });
});
