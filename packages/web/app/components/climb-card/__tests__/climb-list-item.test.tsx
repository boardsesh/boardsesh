import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';
import type { Climb, BoardDetails } from '@/app/lib/types';

// --- Mocks ---

let capturedSwipeOptions: Record<string, unknown> | null = null;

// usePathname and useIsDarkMode are no longer called inside ClimbListItem —
// pathname and isDark are passed as props from the parent.

vi.mock('../../climb-actions', () => ({
  ClimbActions: () => <div data-testid="climb-actions" />,
}));

const mockDoubleTapFavorite = {
  handleDoubleTap: vi.fn(),
  showHeart: false,
  dismissHeart: vi.fn(),
  isFavorited: false,
  toggleFavorite: vi.fn(),
};

vi.mock('../../climb-actions/use-double-tap-favorite', () => ({
  useDoubleTapFavorite: () => mockDoubleTapFavorite,
}));

vi.mock('../../auth/auth-modal', () => ({
  default: () => null,
}));

vi.mock('../heart-animation-overlay', () => ({
  default: ({ visible, onAnimationEnd, size }: { visible: boolean; onAnimationEnd: () => void; size?: number }) =>
    visible ? <div data-testid="heart-animation-overlay" data-size={size} onClick={onAnimationEnd} /> : null,
}));

vi.mock('../drawer-favorite-button', () => ({
  default: () => <span data-testid="drawer-favorite-button" />,
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

let capturedDoubleTapCallback: (() => void) | undefined;
const mockOnDoubleClick = vi.fn();

vi.mock('@/app/lib/hooks/use-double-tap', () => ({
  useDoubleTap: (callback: (() => void) | undefined) => {
    capturedDoubleTapCallback = callback;
    mockOnDoubleClick.mockImplementation(() => callback?.());
    return {
      ref: vi.fn(),
      onDoubleClick: mockOnDoubleClick,
    };
  },
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

// Default props that every ClimbListItem render needs
const defaultPathname = '/kilter/original/12x12/default/40/list';
const defaultIsDark = false;

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
    capturedDoubleTapCallback = undefined;
    // Reset to default state
    mockDoubleTapFavorite.handleDoubleTap = vi.fn();
    mockDoubleTapFavorite.showHeart = false;
    mockDoubleTapFavorite.dismissHeart = vi.fn();
    mockDoubleTapFavorite.isFavorited = false;
    mockDoubleTapFavorite.toggleFavorite = vi.fn();
  });

  describe('basic rendering', () => {
    it('renders climb name', () => {
      render(<ClimbListItem pathname={defaultPathname} isDark={defaultIsDark} climb={makeClimb({ name: 'Cool Route' })} boardDetails={makeBoardDetails()} />);
      expect(screen.getByText('Cool Route')).toBeTruthy();
    });

    it('renders setter username', () => {
      render(<ClimbListItem pathname={defaultPathname} isDark={defaultIsDark} climb={makeClimb({ setter_username: 'alice' })} boardDetails={makeBoardDetails()} />);
      expect(screen.getByText(/alice/)).toBeTruthy();
    });

    it('renders V-grade', () => {
      render(<ClimbListItem pathname={defaultPathname} isDark={defaultIsDark} climb={makeClimb({ difficulty: 'V5' })} boardDetails={makeBoardDetails()} />);
      expect(screen.getByText('V5')).toBeTruthy();
    });

    it('renders thumbnail', () => {
      render(<ClimbListItem pathname={defaultPathname} isDark={defaultIsDark} climb={makeClimb()} boardDetails={makeBoardDetails()} />);
      expect(screen.getByTestId('climb-thumbnail')).toBeTruthy();
    });

    it('renders ellipsis menu button', () => {
      render(<ClimbListItem pathname={defaultPathname} isDark={defaultIsDark} climb={makeClimb()} boardDetails={makeBoardDetails()} />);
      // There should be a button with the MoreHorizOutlined icon
      const buttons = screen.getAllByRole('button');
      expect(buttons.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('disableSwipe behavior', () => {
    it('does not render swipe action backgrounds when disableSwipe is true', () => {
      render(
        <ClimbListItem pathname={defaultPathname} isDark={defaultIsDark} climb={makeClimb()} boardDetails={makeBoardDetails()} disableSwipe />,
      );

      // Swipe icons (LocalOfferOutlined and AddOutlined) should not be in the DOM
      expect(screen.queryByTestId('LocalOfferOutlinedIcon')).toBeNull();
      expect(screen.queryByTestId('AddOutlinedIcon')).toBeNull();
    });

    it('renders swipe action backgrounds when disableSwipe is false/undefined', () => {
      render(
        <ClimbListItem pathname={defaultPathname} isDark={defaultIsDark} climb={makeClimb()} boardDetails={makeBoardDetails()} />,
      );

      // Swipe icons should be present when swipe is enabled
      expect(screen.getByTestId('LocalOfferOutlinedIcon')).toBeTruthy();
      expect(screen.getByTestId('AddOutlinedIcon')).toBeTruthy();
    });

    it('renders ellipsis menu regardless of disableSwipe', () => {
      render(
        <ClimbListItem pathname={defaultPathname} isDark={defaultIsDark} climb={makeClimb()} boardDetails={makeBoardDetails()} disableSwipe />,
      );

      const buttons = screen.getAllByRole('button');
      expect(buttons.length).toBeGreaterThanOrEqual(1);
    });

    it('opens actions drawer on ellipsis click even with disableSwipe', async () => {
      render(
        <ClimbListItem pathname={defaultPathname} isDark={defaultIsDark} climb={makeClimb()} boardDetails={makeBoardDetails()} disableSwipe />,
      );

      // Click the ellipsis menu button
      const button = screen.getByLabelText('More actions');
      fireEvent.click(button);

      // Actions drawer should now be mounted
      expect(await screen.findByTestId('climb-actions')).toBeTruthy();
    });
  });

  it('configures short swipe and long-right swipe thresholds for queue and playlist actions', () => {
    render(<ClimbListItem pathname={defaultPathname} isDark={defaultIsDark} climb={makeClimb()} boardDetails={makeBoardDetails()} />);

    expect(capturedSwipeOptions).not.toBeNull();
    expect(capturedSwipeOptions?.swipeThreshold).toBe(60);
    expect(capturedSwipeOptions?.longSwipeRightThreshold).toBe(150);
    expect(capturedSwipeOptions?.maxSwipe).toBe(180);
    expect(capturedSwipeOptions?.maxSwipeLeft).toBe(100);
    expect(typeof capturedSwipeOptions?.onSwipeRightLong).toBe('function');
  });

  describe('swipe action overrides', () => {
    it('renders override icon instead of default when swipeRightAction is provided', () => {
      render(
        <ClimbListItem
          pathname={defaultPathname}
          isDark={defaultIsDark}
          climb={makeClimb()}
          boardDetails={makeBoardDetails()}
          swipeRightAction={{ icon: <span data-testid="custom-right-icon" />, color: 'red', onAction: vi.fn() }}
        />,
      );

      // Custom right icon should be present
      expect(screen.getByTestId('custom-right-icon')).toBeTruthy();
      // Default add-to-queue icon should NOT be present
      expect(screen.queryByTestId('AddOutlinedIcon')).toBeNull();
      // Default left action (playlist/actions) should still be present
      expect(screen.getByTestId('LocalOfferOutlinedIcon')).toBeTruthy();
    });

    it('keeps default swipe thresholds when swipeRightAction is provided', () => {
      render(
        <ClimbListItem
          pathname={defaultPathname}
          isDark={defaultIsDark}
          climb={makeClimb()}
          boardDetails={makeBoardDetails()}
          swipeRightAction={{ icon: <span />, color: 'red', onAction: vi.fn() }}
        />,
      );

      expect(capturedSwipeOptions).not.toBeNull();
      expect(capturedSwipeOptions?.swipeThreshold).toBe(60);
      expect(capturedSwipeOptions?.maxSwipe).toBe(180);
      expect(capturedSwipeOptions?.maxSwipeLeft).toBe(120);
      expect(capturedSwipeOptions?.longSwipeRightThreshold).toBe(150);
      expect(capturedSwipeOptions?.confirmationPeekOffset).toBe(120);
      expect(typeof capturedSwipeOptions?.onSwipeRightLong).toBe('function');
    });

    it('calls swipeRightAction.onAction on swipe left', () => {
      const onAction = vi.fn();
      render(
        <ClimbListItem
          pathname={defaultPathname}
          isDark={defaultIsDark}
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
  });

  describe('afterTitleSlot', () => {
    it('renders afterTitleSlot content between title and menu', () => {
      render(
        <ClimbListItem
          pathname={defaultPathname}
          isDark={defaultIsDark}
          climb={makeClimb()}
          boardDetails={makeBoardDetails()}
          afterTitleSlot={<span data-testid="after-title-content">Avatar</span>}
        />,
      );

      expect(screen.getByTestId('after-title-content')).toBeTruthy();
      expect(screen.getByText('Avatar')).toBeTruthy();
    });

    it('does not render afterTitleSlot when not provided', () => {
      render(<ClimbListItem pathname={defaultPathname} isDark={defaultIsDark} climb={makeClimb()} boardDetails={makeBoardDetails()} />);
      expect(screen.queryByTestId('after-title-content')).toBeNull();
    });
  });

  describe('titleProps override', () => {
    it('uses default ClimbTitle props when titleProps is not provided', () => {
      render(<ClimbListItem pathname={defaultPathname} isDark={defaultIsDark} climb={makeClimb()} boardDetails={makeBoardDetails()} />);
      // Default renders setter info
      expect(screen.getByText(/setter_joe/)).toBeTruthy();
    });

    it('overrides ClimbTitle props when titleProps is provided', () => {
      render(
        <ClimbListItem
          pathname={defaultPathname}
          isDark={defaultIsDark}
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
          pathname={defaultPathname}
          isDark={defaultIsDark}
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
          pathname={defaultPathname}
          isDark={defaultIsDark}
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
        <ClimbListItem pathname={defaultPathname} isDark={defaultIsDark} climb={makeClimb()} boardDetails={makeBoardDetails()} />,
      );

      const contentDiv = container.querySelector('[style*="user-select: none"]') as HTMLElement;
      expect(contentDiv).toBeTruthy();
      expect(contentDiv.style.opacity).toBe('1');
    });
  });

  describe('disableRipple optimization', () => {
    it('renders menu button with disableRipple to reduce closure overhead', () => {
      render(<ClimbListItem pathname={defaultPathname} isDark={defaultIsDark} climb={makeClimb()} boardDetails={makeBoardDetails()} />);
      const menuButton = screen.getByLabelText('More actions');
      expect(menuButton).toBeTruthy();
      // MUI's disableRipple removes the MuiTouchRipple child element from the DOM
      const ripple = menuButton.querySelector('.MuiTouchRipple-root');
      expect(ripple).toBeNull();
    });
  });

  describe('double-tap to like', () => {
    it('passes handleDoubleTap to useDoubleTap hook', () => {
      render(<ClimbListItem pathname={defaultPathname} isDark={defaultIsDark} climb={makeClimb()} boardDetails={makeBoardDetails()} />);
      expect(capturedDoubleTapCallback).toBe(mockDoubleTapFavorite.handleDoubleTap);
    });

    it('calls handleDoubleTap when thumbnail is double-clicked', () => {
      render(<ClimbListItem pathname={defaultPathname} isDark={defaultIsDark} climb={makeClimb()} boardDetails={makeBoardDetails()} />);

      const thumbnail = screen.getByTestId('climb-thumbnail').parentElement!;
      fireEvent.doubleClick(thumbnail);

      expect(mockDoubleTapFavorite.handleDoubleTap).toHaveBeenCalled();
    });

    it('shows heart animation overlay when showHeart is true', () => {
      mockDoubleTapFavorite.showHeart = true;
      render(<ClimbListItem pathname={defaultPathname} isDark={defaultIsDark} climb={makeClimb()} boardDetails={makeBoardDetails()} />);

      expect(screen.getByTestId('heart-animation-overlay')).toBeTruthy();
      expect(screen.getByTestId('heart-animation-overlay').getAttribute('data-size')).toBe('32');
    });

    it('does not show heart animation overlay when showHeart is false', () => {
      mockDoubleTapFavorite.showHeart = false;
      render(<ClimbListItem pathname={defaultPathname} isDark={defaultIsDark} climb={makeClimb()} boardDetails={makeBoardDetails()} />);

      expect(screen.queryByTestId('heart-animation-overlay')).toBeNull();
    });

    it('calls dismissHeart when heart animation ends', () => {
      mockDoubleTapFavorite.showHeart = true;
      render(<ClimbListItem pathname={defaultPathname} isDark={defaultIsDark} climb={makeClimb()} boardDetails={makeBoardDetails()} />);

      // Our mock uses onClick to simulate onAnimationEnd
      fireEvent.click(screen.getByTestId('heart-animation-overlay'));
      expect(mockDoubleTapFavorite.dismissHeart).toHaveBeenCalled();
    });

    it('delays onThumbnailClick to avoid conflict with double-click', () => {
      vi.useFakeTimers();
      const onThumbnailClick = vi.fn();
      render(
        <ClimbListItem
          pathname={defaultPathname}
          isDark={defaultIsDark}
          climb={makeClimb()}
          boardDetails={makeBoardDetails()}
          onThumbnailClick={onThumbnailClick}
        />,
      );

      const thumbnail = screen.getByTestId('climb-thumbnail').parentElement!;
      fireEvent.click(thumbnail);

      // Should not fire immediately
      expect(onThumbnailClick).not.toHaveBeenCalled();

      // Should fire after 300ms delay
      vi.advanceTimersByTime(300);
      expect(onThumbnailClick).toHaveBeenCalledOnce();

      vi.useRealTimers();
    });

    it('calls onThumbnailClick immediately when disableThumbnailNavigation is true', () => {
      const onThumbnailClick = vi.fn();
      render(
        <ClimbListItem
          pathname={defaultPathname}
          isDark={defaultIsDark}
          climb={makeClimb()}
          boardDetails={makeBoardDetails()}
          disableThumbnailNavigation
          onThumbnailClick={onThumbnailClick}
        />,
      );

      const thumbnail = screen.getByTestId('climb-thumbnail').parentElement!;
      fireEvent.click(thumbnail);

      expect(onThumbnailClick).toHaveBeenCalledOnce();
    });

    it('cancels pending onThumbnailClick when double-click fires', () => {
      vi.useFakeTimers();
      const onThumbnailClick = vi.fn();
      render(
        <ClimbListItem
          pathname={defaultPathname}
          isDark={defaultIsDark}
          climb={makeClimb()}
          boardDetails={makeBoardDetails()}
          onThumbnailClick={onThumbnailClick}
        />,
      );

      const thumbnail = screen.getByTestId('climb-thumbnail').parentElement!;

      // First click starts the delayed handler
      fireEvent.click(thumbnail);
      // Double-click cancels it and triggers the like
      fireEvent.doubleClick(thumbnail);

      // Advance past the delay
      vi.advanceTimersByTime(300);

      // onThumbnailClick should never have fired
      expect(onThumbnailClick).not.toHaveBeenCalled();
      // Double-tap handler should have fired
      expect(mockDoubleTapFavorite.handleDoubleTap).toHaveBeenCalled();

      vi.useRealTimers();
    });

    it('falls back to onNavigate when onThumbnailClick is not provided', () => {
      const onNavigate = vi.fn();
      render(
        <ClimbListItem
          pathname={defaultPathname}
          isDark={defaultIsDark}
          climb={makeClimb()}
          boardDetails={makeBoardDetails()}
          onNavigate={onNavigate}
        />,
      );

      const thumbnail = screen.getByTestId('climb-thumbnail').parentElement!;
      fireEvent.click(thumbnail);
      expect(onNavigate).toHaveBeenCalledOnce();
    });
  });
});
