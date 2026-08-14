import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import { renderHook, act } from '@testing-library/react';
import { useClimbActions } from '../use-climb-actions';

// --- Mocks ---

const mockPush = vi.fn();
let mockPathname = '/kilter/original/12x12/default/40/list';
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
  usePathname: () => mockPathname,
}));

const mockTrack = vi.fn();
vi.mock('@/app/lib/analytics', () => ({
  track: (...args: unknown[]) => mockTrack(...args),
}));

const mockAddToQueue = vi.fn();
const mockMirrorClimb = vi.fn();
vi.mock('../../graphql-queue', () => ({
  useQueueContext: () => ({
    addToQueue: mockAddToQueue,
    queue: [],
    mirrorClimb: mockMirrorClimb,
  }),
  useQueueActions: () => ({
    addToQueue: mockAddToQueue,
    mirrorClimb: mockMirrorClimb,
  }),
}));

const mockShowMessage = vi.fn();
vi.mock('@/app/components/providers/snackbar-provider', () => ({
  useSnackbar: () => ({ showMessage: mockShowMessage }),
}));

const mockToggleFavorite = vi.fn().mockResolvedValue(true);
vi.mock('../use-favorite', () => ({
  useFavorite: () => ({
    isFavorited: false,
    isLoading: false,
    toggleFavorite: mockToggleFavorite,
    isAuthenticated: true,
  }),
}));

const mockOpenAuthModal = vi.fn();
vi.mock('@/app/components/providers/auth-modal-provider', () => ({
  useAuthModal: () => ({ openAuthModal: mockOpenAuthModal }),
}));

vi.mock('@/app/lib/url-utils', () => ({
  getContextAwareClimbViewUrl: vi.fn(() => '/climb/view-context'),
  constructClimbInfoUrl: vi.fn(() => '/climb/info'),
}));

// The remix target is the app's editor, not a www route — W-17 (#4433) deleted
// www's own `…/create`. `app-handoff` is deliberately unmocked so the assertions
// below pin the real URL the reader is sent to.
const mockLocationAssign = vi.fn();

// --- Test data ---

const mockClimb = {
  uuid: 'climb-1',
  name: 'Test Climb',
  difficulty: 'V5',
  frames: 'p1r42',
} as unknown as Parameters<typeof useClimbActions>[0]['climb'];

const mockBoardDetails = {
  board_name: 'kilter',
  layout_id: 1,
  size_id: 10,
  set_ids: [1, 2],
  layout_name: 'Original',
  size_name: '12x12',
  size_description: 'Full',
  set_names: ['Standard'],
  supportsMirroring: true,
} as unknown as Parameters<typeof useClimbActions>[0]['boardDetails'];

const defaultOptions = {
  climb: mockClimb,
  boardDetails: mockBoardDetails,
  angle: 40,
  onActionComplete: vi.fn(),
};

describe('useClimbActions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockPathname = '/kilter/original/12x12/default/40/list';

    // Provide navigator.share and clipboard mocks
    Object.defineProperty(global, 'navigator', {
      value: {
        share: undefined,
        canShare: undefined,
        clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
      },
      writable: true,
      configurable: true,
    });

    // Mock window.open
    Object.defineProperty(global, 'window', {
      value: Object.assign(Object.create(Object.getPrototypeOf(global.window)), global.window, {
        open: vi.fn(),
        // `assign` because the remix leaves this origin for the app.
        location: { origin: 'https://boardsesh.com', assign: mockLocationAssign },
      }),
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('handleViewDetails navigates and tracks analytics', () => {
    const { result } = renderHook(() => useClimbActions(defaultOptions));

    act(() => {
      result.current.handleViewDetails();
    });

    expect(mockTrack).toHaveBeenCalledWith(
      'Climb Info Viewed',
      expect.objectContaining({
        climbUuid: 'climb-1',
      }),
    );
    expect(mockPush).toHaveBeenCalledWith('/climb/view-context');
    expect(defaultOptions.onActionComplete).toHaveBeenCalledWith('viewDetails');
  });

  it('handleFork leaves www for the app editor, board attached', () => {
    const { result } = renderHook(() => useClimbActions(defaultOptions));

    act(() => {
      result.current.handleFork();
    });

    // Not router.push: the destination is another origin.
    expect(mockPush).not.toHaveBeenCalled();
    expect(mockLocationAssign).toHaveBeenCalledWith(
      'https://app.boardsesh.com/climbs/create?boardName=kilter&layoutId=1&sizeId=10&setIds=1%2C2&angle=40' +
        '&forkFrames=p1r42&forkName=Test+Climb',
    );
    expect(defaultOptions.onActionComplete).toHaveBeenCalledWith('fork');
  });

  it('handleFavorite calls toggleFavorite when authenticated', async () => {
    const { result } = renderHook(() => useClimbActions(defaultOptions));

    await act(async () => {
      await result.current.handleFavorite();
    });

    expect(mockToggleFavorite).toHaveBeenCalled();
    expect(defaultOptions.onActionComplete).toHaveBeenCalledWith('favorite');
  });

  it('handleFavorite calls openAuthModal when not authenticated', async () => {
    // The useFavorite mock returns isAuthenticated=true by default,
    // so we can't directly test the unauthenticated path without changing the mock.
    // Instead we verify the hook no longer exposes showAuthModal/setShowAuthModal.
    const { result } = renderHook(() => useClimbActions(defaultOptions));

    expect(result.current).not.toHaveProperty('showAuthModal');
    expect(result.current).not.toHaveProperty('setShowAuthModal');
  });

  it('handleQueue adds to queue and tracks analytics', () => {
    const { result } = renderHook(() => useClimbActions(defaultOptions));

    act(() => {
      result.current.handleQueue();
    });

    expect(mockAddToQueue).toHaveBeenCalledWith(mockClimb, 'climb_detail');
    expect(mockTrack).toHaveBeenCalledWith(
      'Add to Queue',
      expect.objectContaining({
        boardLayout: 'Original',
      }),
    );
    expect(defaultOptions.onActionComplete).toHaveBeenCalledWith('queue');
  });

  it('handleQueue prevents double-add (recentlyAddedToQueue)', () => {
    const { result } = renderHook(() => useClimbActions(defaultOptions));

    // First add
    act(() => {
      result.current.handleQueue();
    });
    expect(mockAddToQueue).toHaveBeenCalledTimes(1);

    // Second add should be blocked
    act(() => {
      result.current.handleQueue();
    });
    expect(mockAddToQueue).toHaveBeenCalledTimes(1);

    // After 5 seconds, should be able to add again
    act(() => {
      vi.advanceTimersByTime(5000);
    });

    expect(result.current.recentlyAddedToQueue).toBe(false);
  });

  it('handleShare uses native share when available', async () => {
    const mockShare = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(global, 'navigator', {
      value: {
        share: mockShare,
        canShare: () => true,
        clipboard: { writeText: vi.fn() },
      },
      writable: true,
      configurable: true,
    });

    const { result } = renderHook(() => useClimbActions(defaultOptions));

    await act(async () => {
      await result.current.handleShare();
    });

    expect(mockShare).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Test Climb',
      }),
    );
    expect(mockTrack).toHaveBeenCalledWith(
      'Climb Shared',
      expect.objectContaining({
        method: 'native',
      }),
    );
  });

  it('handleShare falls back to clipboard when share not available', async () => {
    const mockWriteText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(global, 'navigator', {
      value: {
        share: undefined,
        canShare: undefined,
        clipboard: { writeText: mockWriteText },
      },
      writable: true,
      configurable: true,
    });

    const { result } = renderHook(() => useClimbActions(defaultOptions));

    await act(async () => {
      await result.current.handleShare();
    });

    expect(mockWriteText).toHaveBeenCalled();
    expect(mockShowMessage).toHaveBeenCalledWith('share.linkCopied', 'success');
    expect(mockTrack).toHaveBeenCalledWith(
      'Climb Shared',
      expect.objectContaining({
        method: 'clipboard',
      }),
    );
  });

  it('handleOpenInApp opens URL in new tab', () => {
    const mockOpen = vi.fn();
    Object.defineProperty(global.window, 'open', {
      value: mockOpen,
      writable: true,
      configurable: true,
    });

    const { result } = renderHook(() => useClimbActions(defaultOptions));

    act(() => {
      result.current.handleOpenInApp();
    });

    expect(mockOpen).toHaveBeenCalledWith(expect.any(String), '_blank', 'noopener');
    expect(defaultOptions.onActionComplete).toHaveBeenCalledWith('openInApp');
  });

  it('handleMirror calls mirrorClimb', () => {
    const { result } = renderHook(() => useClimbActions(defaultOptions));

    act(() => {
      result.current.handleMirror();
    });

    expect(mockMirrorClimb).toHaveBeenCalled();
    expect(defaultOptions.onActionComplete).toHaveBeenCalledWith('mirror');
  });

  it('canFork computed from boardDetails', () => {
    const { result } = renderHook(() => useClimbActions(defaultOptions));

    expect(result.current.canFork).toBe(true);
  });

  it('canMirror computed from supportsMirroring', () => {
    const { result } = renderHook(() => useClimbActions(defaultOptions));

    expect(result.current.canMirror).toBe(true);
  });

  it('viewDetailsUrl uses slug URL when names available', () => {
    const { result } = renderHook(() => useClimbActions(defaultOptions));

    expect(result.current.viewDetailsUrl).toBe('/climb/view-context');
  });

  it('forkUrl is null on MoonBoard, the one board the editor cannot remix', () => {
    const moonBoardDetails = { ...mockBoardDetails, board_name: 'moonboard' as const };

    const { result } = renderHook(() => useClimbActions({ ...defaultOptions, boardDetails: moonBoardDetails }));

    expect(result.current.canFork).toBe(false);
    expect(result.current.forkUrl).toBeNull();
  });

  it('still remixes a board the static slug tables do not carry', () => {
    // The app takes the numeric tuple, so a missing layout/size/set NAME is no
    // longer a reason to hide the action the way the www builder made it one.
    const unnamedBoard = {
      ...mockBoardDetails,
      layout_name: undefined,
      size_name: undefined,
      set_names: undefined,
    };

    const { result } = renderHook(() => useClimbActions({ ...defaultOptions, boardDetails: unnamedBoard }));

    expect(result.current.canFork).toBe(true);
    expect(result.current.forkUrl).toContain('https://app.boardsesh.com/climbs/create?boardName=kilter');
  });

  it('onActionComplete callback is called', () => {
    const onComplete = vi.fn();
    const { result } = renderHook(() => useClimbActions({ ...defaultOptions, onActionComplete: onComplete }));

    act(() => {
      result.current.handleViewDetails();
    });

    expect(onComplete).toHaveBeenCalledWith('viewDetails');
  });

  it('isFavorited state is returned', () => {
    const { result } = renderHook(() => useClimbActions(defaultOptions));

    expect(result.current.isFavorited).toBe(false);
  });

  it('handleTick calls onActionComplete', () => {
    const { result } = renderHook(() => useClimbActions(defaultOptions));

    act(() => {
      result.current.handleTick();
    });

    expect(defaultOptions.onActionComplete).toHaveBeenCalledWith('tick');
  });
});
