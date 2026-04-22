import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { render, screen } from '@testing-library/react';
import React from 'react';
import type { Climb, BoardDetails, BoardName } from '@/app/lib/types';
import type { ClimbActionResult, ClimbActionMenuItem, ClimbActionType } from '../types';

// --- Mock factories ---

function createMockClimb(overrides?: Partial<Climb>): Climb {
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

function createMockBoardDetails(overrides?: Partial<BoardDetails>): BoardDetails {
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

// --- Mocks (must be before imports) ---

const mockUseOptionalQueueActions = vi.fn();
vi.mock('../../graphql-queue', () => ({
  useOptionalQueueActions: () => mockUseOptionalQueueActions(),
}));

/**
 * Mock action-view-renderer to avoid transitive import issues with theme-config.
 * buildActionResult returns a structured ClimbActionResult so we can test
 * the GoToQueueAction logic (availability, label, callbacks, disabled state).
 */
const mockBuildActionResult = vi.fn();
vi.mock('../action-view-renderer', () => ({
  computeActionDisplay: (_: string, size = 'default') => ({
    shouldShowLabel: true,
    iconSize: size === 'small' ? 14 : size === 'large' ? 20 : 16,
  }),
  buildActionResult: (args: Record<string, unknown>) => {
    mockBuildActionResult(args);
    const onClick = args.onClick as (e?: React.MouseEvent) => void;
    const disabled = args.disabled as boolean | undefined;
    const label = args.label as string;
    const key = args.key as ClimbActionType;
    const available = args.available as boolean;
    const viewMode = args.viewMode as string;

    let element: React.ReactNode = null;
    if (viewMode === 'icon') {
      element = (
        <span data-testid="action-icon" onClick={() => onClick()} style={{ cursor: 'pointer' }}>
          {args.icon as React.ReactNode}
        </span>
      );
    } else {
      element = (
        <button data-testid="action-button" onClick={() => onClick()} disabled={disabled}>
          {label}
        </button>
      );
    }

    const menuItem: ClimbActionMenuItem = {
      key,
      label,
      icon: args.icon as React.ReactNode,
      onClick: () => onClick(),
    };

    return {
      element,
      menuItem,
      key,
      available,
    } satisfies ClimbActionResult;
  },
}));

// Import after mocks
import { GoToQueueAction } from '../actions/go-to-queue-action';
import type { ClimbActionProps } from '../types';

// --- Test data ---

const mockClimb = createMockClimb();
const mockBoardDetails = createMockBoardDetails();

const defaultProps: ClimbActionProps = {
  climb: mockClimb,
  boardDetails: mockBoardDetails,
  angle: 40,
  viewMode: 'list',
  onComplete: vi.fn(),
  onGoToQueue: vi.fn(),
};

/**
 * Wrapper component to render GoToQueueAction (which returns ClimbActionResult, not JSX directly)
 */
function TestGoToQueueAction(props: ClimbActionProps) {
  const result = GoToQueueAction(props);
  return <>{result.element}</>;
}

/**
 * Helper to call GoToQueueAction as a hook and get the raw result.
 * Renders inside a component to ensure hooks are called properly.
 */
function renderGoToQueueActionResult(props: ClimbActionProps) {
  let result: ReturnType<typeof GoToQueueAction> | undefined;

  function Capture() {
    result = GoToQueueAction(props);
    return null;
  }

  render(<Capture />);
  return result!;
}

// --- Tests ---

describe('GoToQueueAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('availability', () => {
    it('returns available: false when no queue context', () => {
      mockUseOptionalQueueActions.mockReturnValue(null);
      const result = renderGoToQueueActionResult(defaultProps);
      expect(result.available).toBe(false);
      expect(result.key).toBe('goToQueue');
    });

    it('returns available: true when queue context and onGoToQueue exist', () => {
      mockUseOptionalQueueActions.mockReturnValue({ addToQueue: vi.fn() });
      const result = renderGoToQueueActionResult(defaultProps);
      expect(result.available).toBe(true);
      expect(result.key).toBe('goToQueue');
    });

    it('returns available: false when onGoToQueue is not provided', () => {
      mockUseOptionalQueueActions.mockReturnValue({ addToQueue: vi.fn() });
      const result = renderGoToQueueActionResult({ ...defaultProps, onGoToQueue: undefined });
      expect(result.available).toBe(false);
    });
  });

  describe('return value', () => {
    it('includes menuItem with label "Go to Queue"', () => {
      mockUseOptionalQueueActions.mockReturnValue({ addToQueue: vi.fn() });
      const result = renderGoToQueueActionResult(defaultProps);
      expect(result.menuItem.label).toBe('Go to Queue');
    });

    it('includes menuItem with key goToQueue', () => {
      mockUseOptionalQueueActions.mockReturnValue({ addToQueue: vi.fn() });
      const result = renderGoToQueueActionResult(defaultProps);
      expect(result.menuItem.key).toBe('goToQueue');
    });
  });

  describe('list mode', () => {
    it('renders with correct label "Go to Queue"', () => {
      mockUseOptionalQueueActions.mockReturnValue({ addToQueue: vi.fn() });
      render(<TestGoToQueueAction {...defaultProps} viewMode="list" />);
      expect(screen.getByRole('button', { name: /go to queue/i })).toBeTruthy();
    });

    it('calls onGoToQueue when clicked, does not call onComplete', () => {
      mockUseOptionalQueueActions.mockReturnValue({ addToQueue: vi.fn() });
      const onGoToQueue = vi.fn();
      const onComplete = vi.fn();
      render(
        <TestGoToQueueAction {...defaultProps} viewMode="list" onGoToQueue={onGoToQueue} onComplete={onComplete} />,
      );

      screen.getByRole('button', { name: /go to queue/i }).click();

      expect(onGoToQueue).toHaveBeenCalledTimes(1);
      expect(onComplete).not.toHaveBeenCalled();
    });

    it('is disabled when onGoToQueue is undefined', () => {
      mockUseOptionalQueueActions.mockReturnValue({ addToQueue: vi.fn() });
      render(<TestGoToQueueAction {...defaultProps} viewMode="list" onGoToQueue={undefined} />);

      const button = screen.getByRole('button', { name: /go to queue/i });
      expect(button).toHaveProperty('disabled', true);
    });
  });

  describe('icon mode', () => {
    it('renders without crashing', () => {
      mockUseOptionalQueueActions.mockReturnValue({ addToQueue: vi.fn() });
      const { container } = render(<TestGoToQueueAction {...defaultProps} viewMode="icon" />);
      expect(container).toBeTruthy();
    });

    it('renders a clickable icon element', () => {
      mockUseOptionalQueueActions.mockReturnValue({ addToQueue: vi.fn() });
      render(<TestGoToQueueAction {...defaultProps} viewMode="icon" />);
      expect(screen.getByTestId('action-icon')).toBeTruthy();
    });

    it('calls onGoToQueue when icon is clicked, does not call onComplete', () => {
      mockUseOptionalQueueActions.mockReturnValue({ addToQueue: vi.fn() });
      const onGoToQueue = vi.fn();
      const onComplete = vi.fn();
      render(
        <TestGoToQueueAction {...defaultProps} viewMode="icon" onGoToQueue={onGoToQueue} onComplete={onComplete} />,
      );

      screen.getByTestId('action-icon').click();

      expect(onGoToQueue).toHaveBeenCalledTimes(1);
      expect(onComplete).not.toHaveBeenCalled();
    });
  });

  describe('button mode', () => {
    it('renders a button', () => {
      mockUseOptionalQueueActions.mockReturnValue({ addToQueue: vi.fn() });
      render(<TestGoToQueueAction {...defaultProps} viewMode="button" />);
      expect(screen.getByRole('button')).toBeTruthy();
    });

    it('shows label in button mode', () => {
      mockUseOptionalQueueActions.mockReturnValue({ addToQueue: vi.fn() });
      render(<TestGoToQueueAction {...defaultProps} viewMode="button" />);
      expect(screen.getByRole('button', { name: /go to queue/i })).toBeTruthy();
    });

    it('calls onGoToQueue when clicked, does not call onComplete in button mode', () => {
      mockUseOptionalQueueActions.mockReturnValue({ addToQueue: vi.fn() });
      const onGoToQueue = vi.fn();
      const onComplete = vi.fn();
      render(
        <TestGoToQueueAction {...defaultProps} viewMode="button" onGoToQueue={onGoToQueue} onComplete={onComplete} />,
      );

      screen.getByRole('button', { name: /go to queue/i }).click();

      expect(onGoToQueue).toHaveBeenCalledTimes(1);
      expect(onComplete).not.toHaveBeenCalled();
    });

    it('is disabled when onGoToQueue is undefined in button mode', () => {
      mockUseOptionalQueueActions.mockReturnValue({ addToQueue: vi.fn() });
      render(<TestGoToQueueAction {...defaultProps} viewMode="button" onGoToQueue={undefined} />);

      const button = screen.getByRole('button', { name: /go to queue/i });
      expect(button).toHaveProperty('disabled', true);
    });
  });

  describe('buildActionResult arguments', () => {
    it('passes correct key and label to buildActionResult', () => {
      mockUseOptionalQueueActions.mockReturnValue({ addToQueue: vi.fn() });
      renderGoToQueueActionResult(defaultProps);

      expect(mockBuildActionResult).toHaveBeenCalledTimes(1);
      const callArgs = mockBuildActionResult.mock.calls[0][0];
      expect(callArgs.key).toBe('goToQueue');
      expect(callArgs.label).toBe('Go to Queue');
    });

    it('passes available: false when queueActions is null', () => {
      mockUseOptionalQueueActions.mockReturnValue(null);
      renderGoToQueueActionResult(defaultProps);

      const callArgs = mockBuildActionResult.mock.calls[0][0];
      expect(callArgs.available).toBe(false);
    });

    it('passes available: true when queueActions exists', () => {
      mockUseOptionalQueueActions.mockReturnValue({ addToQueue: vi.fn() });
      renderGoToQueueActionResult(defaultProps);

      const callArgs = mockBuildActionResult.mock.calls[0][0];
      expect(callArgs.available).toBe(true);
    });

    it('passes disabled: true when onGoToQueue is not provided', () => {
      mockUseOptionalQueueActions.mockReturnValue({ addToQueue: vi.fn() });
      renderGoToQueueActionResult({ ...defaultProps, onGoToQueue: undefined });

      const callArgs = mockBuildActionResult.mock.calls[0][0];
      expect(callArgs.disabled).toBe(true);
    });

    it('passes disabled: false when onGoToQueue is provided and disabled is not set', () => {
      mockUseOptionalQueueActions.mockReturnValue({ addToQueue: vi.fn() });
      renderGoToQueueActionResult({ ...defaultProps, onGoToQueue: vi.fn(), disabled: false });

      const callArgs = mockBuildActionResult.mock.calls[0][0];
      expect(callArgs.disabled).toBe(false);
    });

    it('passes disabled: true when disabled prop is true even with onGoToQueue', () => {
      mockUseOptionalQueueActions.mockReturnValue({ addToQueue: vi.fn() });
      renderGoToQueueActionResult({ ...defaultProps, onGoToQueue: vi.fn(), disabled: true });

      const callArgs = mockBuildActionResult.mock.calls[0][0];
      expect(callArgs.disabled).toBe(true);
    });
  });
});
