import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { renderHook } from '@testing-library/react';
import { SetActiveAction } from '../set-active-action';
import type { ClimbActionProps } from '../../types';
import type { BoardDetails, Climb } from '@/app/lib/types';

// Mock dependencies before importing the module
vi.mock('@/app/lib/analytics', () => ({
  track: vi.fn(),
}));

const mockSetCurrentClimb = vi.fn();
let mockCurrentClimb: { uuid: string } | null = null;

vi.mock('@/app/components/graphql-queue', () => ({
  useQueueContext: () => ({
    setCurrentClimb: mockSetCurrentClimb,
    currentClimb: mockCurrentClimb,
  }),
  useOptionalQueueContext: () => ({
    setCurrentClimb: mockSetCurrentClimb,
    currentClimb: mockCurrentClimb,
  }),
  useOptionalQueueActions: () => ({
    setCurrentClimb: mockSetCurrentClimb,
  }),
  useOptionalQueueData: () => ({
    currentClimb: mockCurrentClimb,
  }),
  useQueueData: () => ({
    currentClimb: mockCurrentClimb,
  }),
  useQueueActions: () => ({
    setCurrentClimb: mockSetCurrentClimb,
  }),
}));

vi.mock('@/app/theme/theme-config', () => ({
  themeTokens: {
    colors: { primary: '#1890ff' },
    spacing: { 4: '16px' },
    typography: { fontSize: { base: '14px' } },
  },
}));

vi.mock('@mui/icons-material/PlayCircleOutlineOutlined', () => ({
  default: () => 'PlayCircleOutlineOutlinedIcon',
}));

vi.mock('@mui/material/Button', () => ({
  default: ({ children }: { children?: React.ReactNode }) => children,
}));

vi.mock('../../action-tooltip', () => ({
  ActionTooltip: ({ children }: { children: React.ReactNode }) => children,
}));

function createTestClimb(overrides?: Partial<Climb>): Climb {
  return {
    uuid: 'test-uuid-789',
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

describe('SetActiveAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCurrentClimb = null;
  });

  describe('availability', () => {
    it('always returns available: true', () => {
      const props = createTestProps();
      const { result } = renderHook(() => SetActiveAction(props));
      expect(result.current.available).toBe(true);
    });

    it('returns key: setActive', () => {
      const props = createTestProps();
      const { result } = renderHook(() => SetActiveAction(props));
      expect(result.current.key).toBe('setActive');
    });
  });

  describe('when climb IS current (uuid matches)', () => {
    beforeEach(() => {
      mockCurrentClimb = { uuid: 'test-uuid-789' };
    });

    it('menuItem label is Active', () => {
      const props = createTestProps();
      const { result } = renderHook(() => SetActiveAction(props));
      expect(result.current.menuItem.label).toBe('Active');
    });

    it('menuItem is disabled', () => {
      const props = createTestProps();
      const { result } = renderHook(() => SetActiveAction(props));
      expect(result.current.menuItem.disabled).toBe(true);
    });
  });

  describe('when climb is NOT current (uuid differs)', () => {
    beforeEach(() => {
      mockCurrentClimb = { uuid: 'different-uuid' };
    });

    it('menuItem label is Set Active', () => {
      const props = createTestProps();
      const { result } = renderHook(() => SetActiveAction(props));
      expect(result.current.menuItem.label).toBe('Set Active');
    });

    it('menuItem is not disabled', () => {
      const props = createTestProps();
      const { result } = renderHook(() => SetActiveAction(props));
      expect(result.current.menuItem.disabled).toBe(false);
    });
  });

  describe('when currentClimb is null', () => {
    beforeEach(() => {
      mockCurrentClimb = null;
    });

    it('menuItem label is Set Active', () => {
      const props = createTestProps();
      const { result } = renderHook(() => SetActiveAction(props));
      expect(result.current.menuItem.label).toBe('Set Active');
    });

    it('menuItem is not disabled', () => {
      const props = createTestProps();
      const { result } = renderHook(() => SetActiveAction(props));
      expect(result.current.menuItem.disabled).toBe(false);
    });
  });

  describe('menuItem structure', () => {
    it('menuItem key is setActive', () => {
      const props = createTestProps();
      const { result } = renderHook(() => SetActiveAction(props));
      expect(result.current.menuItem.key).toBe('setActive');
    });

    it('menuItem icon is defined', () => {
      const props = createTestProps();
      const { result } = renderHook(() => SetActiveAction(props));
      expect(result.current.menuItem.icon).toBeDefined();
    });
  });
});
