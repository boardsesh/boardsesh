import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { ForkAction } from '../fork-action';
import type { ClimbActionProps, ClimbActionResult } from '../../types';
import type { BoardDetails, Climb } from '@/app/lib/types';

// Mock dependencies before importing the module
vi.mock('@/app/lib/analytics', () => ({
  track: vi.fn(),
}));

vi.mock('next/link', () => ({
  default: vi.fn(({ children }: { children: React.ReactNode }) => children),
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
    set_ids: [1, 2],
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

/**
 * The remix href, read off the menu item's label element. Every surface
 * (icon/button/list/menu) is built from the same `url`, so one is enough.
 */
function hrefOf(menuItem: ClimbActionResult['menuItem']): string | undefined {
  const label = menuItem?.label;
  if (!label || typeof label !== 'object' || !('props' in label)) return undefined;
  return (label.props as { href?: string }).href;
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

    it('stays available on a board the static slug tables do not name', () => {
      // The app's editor takes the numeric tuple, so a missing layout/size/set
      // name is no longer a reason to hide the action.
      const props = createTestProps({
        boardDetails: createTestBoardDetails({
          layout_name: undefined,
          size_name: undefined,
          set_names: undefined,
        }),
      });
      const result = ForkAction(props);
      expect(result.available).toBe(true);
    });

    it('returns available: true when the board is not moonboard', () => {
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
    // W-17 (#4433) deleted www's `…/create` routes; a remix opens the app's
    // editor directly, so the seed frames survive instead of being dropped by a
    // redirect that keeps only the pathname.
    it('links straight at the app editor with the board and the seed attached', () => {
      const props = createTestProps();
      const { menuItem } = ForkAction(props);

      expect(hrefOf(menuItem)).toBe(
        'https://app.boardsesh.com/climbs/create?boardName=kilter&layoutId=1&sizeId=10&setIds=1%2C2&angle=40&forkFrames=p1r12p2r13&forkName=Test+Climb',
      );
    });

    it('sends the numeric board tuple, so a shadowed size remixes onto its own board', () => {
      // Kilter layout 1 size 27 shares a bare slug with size 10; ids can't be
      // ambiguous the way the slug was.
      const props = createTestProps({ boardDetails: createTestBoardDetails({ size_id: 27 }) });
      const { menuItem } = ForkAction(props);

      expect(hrefOf(menuItem)).toContain('sizeId=27');
    });

    it('builds no URL on moonboard, the one board the editor cannot remix', () => {
      const props = createTestProps({
        boardDetails: createTestBoardDetails({ board_name: 'moonboard' }),
      });
      const result = ForkAction(props);

      expect(result.available).toBe(false);
      expect(result.menuItem?.disabled).toBe(true);
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
      expect(hrefOf(ForkAction(props).menuItem)).toBe(
        'https://app.boardsesh.com/climbs/create?boardName=kilter&layoutId=1&sizeId=10&setIds=1%2C2&angle=40' +
          '&forkFrames=p1r12p2r13&forkName=Test+Climb&forkDescription=Draft+description' +
          '&editClimbUuid=test-uuid-123',
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
      // Fork params, no editClimbUuid.
      expect(hrefOf(ForkAction(props).menuItem)).toBe(
        'https://app.boardsesh.com/climbs/create?boardName=kilter&layoutId=1&sizeId=10&setIds=1%2C2&angle=40&forkFrames=p1r12p2r13&forkName=Test+Climb',
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
      expect(hrefOf(ForkAction(props).menuItem)).toBe(
        'https://app.boardsesh.com/climbs/create?boardName=kilter&layoutId=1&sizeId=10&setIds=1%2C2&angle=40&forkFrames=p1r12p2r13&forkName=Test+Climb',
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
      expect(hrefOf(ForkAction(props).menuItem)).toBe(
        'https://app.boardsesh.com/climbs/create?boardName=kilter&layoutId=1&sizeId=10&setIds=1%2C2&angle=40&forkFrames=p1r12p2r13&forkName=Test+Climb',
      );
    });
  });
});
