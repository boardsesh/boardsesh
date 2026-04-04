import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';
import type { Climb, BoardDetails } from '@/app/lib/types';

// --- Mocks ---

let capturedSwipeOptions: Record<string, unknown> | null = null;

vi.mock('next/navigation', () => ({
  usePathname: () => '/kilter/original/12x12/default/40/list',
}));

vi.mock('@/app/hooks/use-is-dark-mode', () => ({
  useIsDarkMode: () => false,
}));

vi.mock('../../graphql-queue', () => ({
  useOptionalQueueContext: () => null,
}));

vi.mock('../../climb-actions', () => ({
  useFavorite: () => ({
    isFavorited: false,
    isLoading: false,
    toggleFavorite: vi.fn(),
    isAuthenticated: false,
  }),
  ClimbActions: () => <div data-testid="climb-actions" />,
}));

vi.mock('@/app/hooks/use-swipe-actions', () => ({
  useSwipeActions: (options: { disabled?: boolean }) => {
    capturedSwipeOptions = options;
    return {
    swipeHandlers: { ref: vi.fn() },
    contentRef: vi.fn(),
    leftActionRef: vi.fn(),
    rightActionRef: vi.fn(),
    _disabled: options.disabled,
  };
  },
}));

vi.mock('@/app/lib/hooks/use-double-tap', () => ({
  useDoubleTap: () => ({
    ref: vi.fn(),
    onDoubleClick: vi.fn(),
  }),
}));

vi.mock('@/app/lib/grade-colors', () => ({
  getSoftGradeColor: () => '#888',
  getSoftVGradeColor: () => '#888',
  getGradeTintColor: () => null,
  formatVGrade: (d: string) => (d.startsWith('V') ? d : null),
}));

vi.mock('@/app/lib/climb-action-utils', () => ({
  getExcludedClimbActions: () => [],
}));

vi.mock('../climb-thumbnail', () => ({
  default: () => <div data-testid="climb-thumbnail" />,
}));

vi.mock('../drawer-climb-header', () => ({
  default: () => <div data-testid="drawer-climb-header" />,
}));

vi.mock('../../swipeable-drawer/swipeable-drawer', () => ({
  default: ({ children }: { children: React.ReactNode }) => <div data-testid="swipeable-drawer">{children}</div>,
}));

vi.mock('../ascent-status', () => ({
  AscentStatus: () => <span data-testid="ascent-status" />,
}));

vi.mock('@/app/theme/theme-config', () => ({
  themeTokens: {
    spacing: { 1: 4, 2: 8, 3: 12, 4: 16, 16: 64 },
    colors: { error: '#B8524C', primary: '#8C4A52', success: '#6B9080' },
    neutral: { 200: '#E5E7EB', 400: '#9CA3AF', 500: '#6B7280', 600: '#4B5563' },
    typography: {
      fontSize: { xs: 12, sm: 14, xl: 20, '2xl': 24 },
      fontWeight: { normal: 400, semibold: 600, bold: 700 },
    },
  },
}));

import ClimbListItem from '../climb-list-item';

// --- Helpers ---

function makeClimb(overrides: Partial<Climb> = {}): Climb {
  return {
    uuid: 'climb-1',
    name: 'Test Boulder',
    setter_username: 'setter_joe',
    description: '',
    frames: 'p1r14',
    angle: 40,
    ascensionist_count: 10,
    difficulty: 'V4',
    quality_average: '3.5',
    stars: 0,
    difficulty_error: '0.5',
    benchmark_difficulty: null,
    ...overrides,
  };
}

function makeBoardDetails(overrides: Partial<BoardDetails> = {}): BoardDetails {
  return {
    board_name: 'kilter',
    layout_id: 1,
    size_id: 1,
    set_ids: '1',
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

describe('ClimbListItem', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedSwipeOptions = null;
  });

  describe('basic rendering', () => {
    it('renders climb name', () => {
      render(<ClimbListItem climb={makeClimb({ name: 'Cool Route' })} boardDetails={makeBoardDetails()} />);
      expect(screen.getByText('Cool Route')).toBeTruthy();
    });

    it('renders setter username', () => {
      render(<ClimbListItem climb={makeClimb({ setter_username: 'alice' })} boardDetails={makeBoardDetails()} />);
      expect(screen.getByText(/alice/)).toBeTruthy();
    });

    it('renders V-grade', () => {
      render(<ClimbListItem climb={makeClimb({ difficulty: 'V5' })} boardDetails={makeBoardDetails()} />);
      expect(screen.getByText('V5')).toBeTruthy();
    });

    it('renders thumbnail', () => {
      render(<ClimbListItem climb={makeClimb()} boardDetails={makeBoardDetails()} />);
      expect(screen.getByTestId('climb-thumbnail')).toBeTruthy();
    });

    it('renders ellipsis menu button', () => {
      render(<ClimbListItem climb={makeClimb()} boardDetails={makeBoardDetails()} />);
      // There should be a button with the MoreHorizOutlined icon
      const buttons = screen.getAllByRole('button');
      expect(buttons.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('disableSwipe behavior', () => {
    it('does not render swipe action backgrounds when disableSwipe is true', () => {
      render(
        <ClimbListItem climb={makeClimb()} boardDetails={makeBoardDetails()} disableSwipe />,
      );

      // Swipe icons (FavoriteBorderOutlined and AddOutlined) should not be in the DOM
      expect(screen.queryByTestId('FavoriteBorderOutlinedIcon')).toBeNull();
      expect(screen.queryByTestId('AddOutlinedIcon')).toBeNull();
    });

    it('renders swipe action backgrounds when disableSwipe is false/undefined', () => {
      render(
        <ClimbListItem climb={makeClimb()} boardDetails={makeBoardDetails()} />,
      );

      // Swipe icons should be present when swipe is enabled
      expect(screen.getByTestId('FavoriteBorderOutlinedIcon')).toBeTruthy();
      expect(screen.getByTestId('AddOutlinedIcon')).toBeTruthy();
    });

    it('renders ellipsis menu regardless of disableSwipe', () => {
      render(
        <ClimbListItem climb={makeClimb()} boardDetails={makeBoardDetails()} disableSwipe />,
      );

      const buttons = screen.getAllByRole('button');
      expect(buttons.length).toBeGreaterThanOrEqual(1);
    });

    it('opens actions drawer on ellipsis click even with disableSwipe', async () => {
      render(
        <ClimbListItem climb={makeClimb()} boardDetails={makeBoardDetails()} disableSwipe />,
      );

      // Click the ellipsis menu button
      const button = screen.getByLabelText('More actions');
      fireEvent.click(button);

      // Actions drawer should now be mounted
      expect(await screen.findByTestId('climb-actions')).toBeTruthy();
    });
  });

  it('configures short swipe and long-right swipe thresholds for queue and playlist actions', () => {
    render(<ClimbListItem climb={makeClimb()} boardDetails={makeBoardDetails()} />);

    expect(capturedSwipeOptions).not.toBeNull();
    expect(capturedSwipeOptions?.swipeThreshold).toBe(90);
    expect(capturedSwipeOptions?.longSwipeRightThreshold).toBe(150);
    expect(capturedSwipeOptions?.maxSwipe).toBe(180);
    expect(typeof capturedSwipeOptions?.onSwipeRightLong).toBe('function');
  });

  describe('swipe action overrides', () => {
    it('renders override icons instead of defaults when swipeLeftAction and swipeRightAction are provided', () => {
      render(
        <ClimbListItem
          climb={makeClimb()}
          boardDetails={makeBoardDetails()}
          swipeLeftAction={{ icon: <span data-testid="custom-left-icon" />, color: 'green', onAction: vi.fn() }}
          swipeRightAction={{ icon: <span data-testid="custom-right-icon" />, color: 'red', onAction: vi.fn() }}
        />,
      );

      // Custom icons should be present
      expect(screen.getByTestId('custom-left-icon')).toBeTruthy();
      expect(screen.getByTestId('custom-right-icon')).toBeTruthy();
      // Default icons should NOT be present
      expect(screen.queryByTestId('FavoriteBorderOutlinedIcon')).toBeNull();
      expect(screen.queryByTestId('AddOutlinedIcon')).toBeNull();
    });

    it('uses simple swipe thresholds when overrides are provided', () => {
      render(
        <ClimbListItem
          climb={makeClimb()}
          boardDetails={makeBoardDetails()}
          swipeLeftAction={{ icon: <span />, color: 'green', onAction: vi.fn() }}
          swipeRightAction={{ icon: <span />, color: 'red', onAction: vi.fn() }}
        />,
      );

      expect(capturedSwipeOptions).not.toBeNull();
      expect(capturedSwipeOptions?.swipeThreshold).toBe(100);
      expect(capturedSwipeOptions?.maxSwipe).toBe(120);
      expect(capturedSwipeOptions?.longSwipeRightThreshold).toBeUndefined();
      expect(capturedSwipeOptions?.onSwipeRightLong).toBeUndefined();
    });

    it('calls swipeRightAction.onAction on swipe left', () => {
      const onAction = vi.fn();
      render(
        <ClimbListItem
          climb={makeClimb()}
          boardDetails={makeBoardDetails()}
          swipeRightAction={{ icon: <span />, color: 'red', onAction }}
        />,
      );

      // The hook's onSwipeLeft should call swipeRightAction.onAction
      const swipeLeftHandler = capturedSwipeOptions?.onSwipeLeft as () => void;
      swipeLeftHandler();
      expect(onAction).toHaveBeenCalledOnce();
    });

    it('calls swipeLeftAction.onAction on swipe right', () => {
      const onAction = vi.fn();
      render(
        <ClimbListItem
          climb={makeClimb()}
          boardDetails={makeBoardDetails()}
          swipeLeftAction={{ icon: <span />, color: 'green', onAction }}
        />,
      );

      // The hook's onSwipeRight should call swipeLeftAction.onAction
      const swipeRightHandler = capturedSwipeOptions?.onSwipeRight as () => void;
      swipeRightHandler();
      expect(onAction).toHaveBeenCalledOnce();
    });
  });

  describe('afterTitleSlot', () => {
    it('renders afterTitleSlot content between title and menu', () => {
      render(
        <ClimbListItem
          climb={makeClimb()}
          boardDetails={makeBoardDetails()}
          afterTitleSlot={<span data-testid="after-title-content">Avatar</span>}
        />,
      );

      expect(screen.getByTestId('after-title-content')).toBeTruthy();
      expect(screen.getByText('Avatar')).toBeTruthy();
    });

    it('does not render afterTitleSlot when not provided', () => {
      render(<ClimbListItem climb={makeClimb()} boardDetails={makeBoardDetails()} />);
      expect(screen.queryByTestId('after-title-content')).toBeNull();
    });
  });

  describe('menuSlot', () => {
    it('renders custom menuSlot instead of default ellipsis button', () => {
      render(
        <ClimbListItem
          climb={makeClimb()}
          boardDetails={makeBoardDetails()}
          menuSlot={<button data-testid="custom-menu">Menu</button>}
        />,
      );

      expect(screen.getByTestId('custom-menu')).toBeTruthy();
      // Default ellipsis button should not be present (icon may still exist in swipe action layer)
      expect(screen.queryByRole('button', { name: /more/i })).toBeNull();
    });

    it('does not render actions drawers when menuSlot is provided', () => {
      render(
        <ClimbListItem
          climb={makeClimb()}
          boardDetails={makeBoardDetails()}
          menuSlot={<button data-testid="custom-menu">Menu</button>}
        />,
      );

      // SwipeableDrawer should not be rendered at all
      expect(screen.queryByTestId('swipeable-drawer')).toBeNull();
    });

    it('renders null menuSlot (hides menu entirely)', () => {
      render(
        <ClimbListItem
          climb={makeClimb()}
          boardDetails={makeBoardDetails()}
          menuSlot={null}
        />,
      );

      // No menu button rendered (icon may still exist in swipe action layer)
      const buttons = screen.queryAllByRole('button');
      expect(buttons.length).toBe(0);
    });
  });

  describe('titleProps override', () => {
    it('uses default ClimbTitle props when titleProps is not provided', () => {
      render(<ClimbListItem climb={makeClimb()} boardDetails={makeBoardDetails()} />);
      // Default renders setter info
      expect(screen.getByText(/setter_joe/)).toBeTruthy();
    });

    it('overrides ClimbTitle props when titleProps is provided', () => {
      render(
        <ClimbListItem
          climb={makeClimb()}
          boardDetails={makeBoardDetails()}
          titleProps={{ showAngle: true, centered: true }}
        />,
      );

      // With showAngle and no showSetterInfo, setter should not appear
      expect(screen.queryByText(/setter_joe/)).toBeNull();
      // Angle should be shown
      expect(screen.getByText(/40°/)).toBeTruthy();
    });
  });

  describe('backgroundColor override', () => {
    it('applies custom backgroundColor to content', () => {
      const { container } = render(
        <ClimbListItem
          climb={makeClimb()}
          boardDetails={makeBoardDetails()}
          backgroundColor="rgb(255, 0, 0)"
        />,
      );

      // The swipeable content div has user-select: none and the custom backgroundColor
      const contentDiv = container.querySelector('[style*="user-select: none"]') as HTMLElement;
      expect(contentDiv).toBeTruthy();
      expect(contentDiv.style.backgroundColor).toBe('rgb(255, 0, 0)');
    });
  });

  describe('contentOpacity', () => {
    it('applies custom contentOpacity to content', () => {
      const { container } = render(
        <ClimbListItem
          climb={makeClimb()}
          boardDetails={makeBoardDetails()}
          contentOpacity={0.6}
        />,
      );

      // The swipeable content div has user-select: none
      const contentDiv = container.querySelector('[style*="user-select: none"]') as HTMLElement;
      expect(contentDiv).toBeTruthy();
      expect(contentDiv.style.opacity).toBe('0.6');
    });

    it('defaults to opacity 1 when contentOpacity is not provided', () => {
      const { container } = render(
        <ClimbListItem climb={makeClimb()} boardDetails={makeBoardDetails()} />,
      );

      const contentDiv = container.querySelector('[style*="user-select: none"]') as HTMLElement;
      expect(contentDiv).toBeTruthy();
      expect(contentDiv.style.opacity).toBe('1');
    });
  });
});
