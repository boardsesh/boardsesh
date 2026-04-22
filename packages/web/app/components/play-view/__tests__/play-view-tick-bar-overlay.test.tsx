// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import React from 'react';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';

// ---------------------------------------------------------------------------
// Mocks — must come before imports
// ---------------------------------------------------------------------------

const mockGetPreference = vi.fn().mockResolvedValue(null);
const mockSetPreference = vi.fn().mockResolvedValue(undefined);
vi.mock('@/app/lib/user-preferences-db', () => ({
  getPreference: (...args: unknown[]) => mockGetPreference(...args),
  setPreference: (...args: unknown[]) => mockSetPreference(...args),
}));

// Stable reference — a new [] on every render causes the climb-change effect
// to re-fire and reset tickBarExpanded.
const stableLogbook: never[] = [];
vi.mock('@/app/components/board-provider/board-provider-context', () => ({
  useBoardProvider: () => ({ logbook: stableLogbook }),
}));

vi.mock('@/app/hooks/use-tick-save', () => ({
  hasPriorHistoryForClimb: () => false,
}));

vi.mock('@/app/hooks/use-is-dark-mode', () => ({
  useIsDarkMode: () => false,
}));

vi.mock('@/app/lib/grade-colors', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    getGradeTintColor: () => null,
  };
});

vi.mock('@/app/components/logbook/quick-tick-bar', () => ({
  QuickTickBar: React.forwardRef(() => React.createElement('div', { 'data-testid': 'quick-tick-bar' })),
}));

vi.mock('@/app/components/logbook/tick-icon', () => ({
  TickIcon: () => React.createElement('svg', { 'data-testid': 'tick-icon' }),
  TickButtonWithLabel: ({ children, label }: { children: React.ReactNode; label: string }) =>
    React.createElement('div', { 'data-testid': `tick-label-${label}` }, children),
}));

vi.mock('@/app/components/icons/person-falling-icon', () => ({
  PersonFallingIcon: () => React.createElement('svg', { 'data-testid': 'person-falling-icon' }),
}));

vi.mock('@mui/icons-material/CloseOutlined', () => ({
  default: () => React.createElement('svg', { 'data-testid': 'icon-close' }),
}));
vi.mock('@mui/icons-material/KeyboardArrowUpOutlined', () => ({
  default: () => React.createElement('svg', { 'data-testid': 'icon-arrow-up' }),
}));
vi.mock('@mui/icons-material/KeyboardArrowDownOutlined', () => ({
  default: () => React.createElement('svg', { 'data-testid': 'icon-arrow-down' }),
}));
vi.mock('@mui/icons-material/ChatBubbleOutlineOutlined', () => ({
  default: () => React.createElement('svg', { 'data-testid': 'icon-chat' }),
}));
vi.mock('@mui/icons-material/CheckOutlined', () => ({
  default: () => React.createElement('svg', { 'data-testid': 'icon-check' }),
}));

vi.mock('@/app/components/providers/snackbar-provider', () => ({
  useSnackbar: () => ({ showMessage: vi.fn() }),
}));

// Import after mocks
import { PlayViewTickBar } from '../play-view-drawer';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const mockClimb = {
  uuid: 'climb-1',
  setter_username: 'setter1',
  name: 'Test Climb',
  description: '',
  frames: '',
  angle: 40,
  ascensionist_count: 5,
  difficulty: '7',
  quality_average: '3.5',
  stars: 3,
  difficulty_error: '',
  mirrored: false,
  benchmark_difficulty: null,
  userAscents: 0,
  userAttempts: 0,
};

const defaultProps = {
  isTickBarActive: false,
  currentClimb: mockClimb as never,
  angle: 40 as never,
  boardDetails: {
    board_name: 'kilter',
    layout_id: 1,
    size_id: 1,
    set_ids: '1',
    images_to_holds: {},
    layout_name: 'Original',
    size_name: '12x12',
    size_description: 'Standard',
    set_names: ['Base'],
    edge_left: 0,
    edge_right: 0,
    edge_bottom: 0,
    edge_top: 0,
  } as never,
  onClose: vi.fn(),
  onError: vi.fn(),
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PlayViewTickBar expanded state persistence', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetPreference.mockResolvedValue(null);
    mockSetPreference.mockResolvedValue(undefined);
  });

  it('does not read preference when tick bar is inactive', () => {
    render(<PlayViewTickBar {...defaultProps} isTickBarActive={false} />);

    expect(mockGetPreference).not.toHaveBeenCalledWith('tickBarExpanded');
  });

  it('reads persisted expanded state when tick bar becomes active', async () => {
    render(<PlayViewTickBar {...defaultProps} isTickBarActive={true} />);

    await waitFor(() => {
      expect(mockGetPreference).toHaveBeenCalledWith('tickBarExpanded');
    });
  });

  it('restores expanded state when persisted value is true', async () => {
    mockGetPreference.mockResolvedValue(true);

    render(<PlayViewTickBar {...defaultProps} isTickBarActive={true} />);

    // Should show "Collapse" label (meaning it's in expanded mode)
    await waitFor(() => {
      expect(screen.getByText('Collapse')).toBeTruthy();
    });
  });

  it('starts collapsed when persisted value is null', async () => {
    mockGetPreference.mockResolvedValue(null);

    render(<PlayViewTickBar {...defaultProps} isTickBarActive={true} />);

    // Wait for async preference read to complete
    await waitFor(() => {
      expect(mockGetPreference).toHaveBeenCalledWith('tickBarExpanded');
    });

    // Should show "Expand" label (meaning it's in collapsed mode)
    expect(screen.getByText('Expand')).toBeTruthy();
  });

  it('persists expanded state when user clicks expand', async () => {
    render(<PlayViewTickBar {...defaultProps} isTickBarActive={true} />);

    await waitFor(() => {
      expect(mockGetPreference).toHaveBeenCalledWith('tickBarExpanded');
    });

    // Click expand button
    const expandButton = screen.getByLabelText('Expand tick bar');
    act(() => {
      fireEvent.click(expandButton);
    });

    expect(mockSetPreference).toHaveBeenCalledWith('tickBarExpanded', true);
  });

  it('persists collapsed state when user clicks collapse', async () => {
    mockGetPreference.mockResolvedValue(true);

    render(<PlayViewTickBar {...defaultProps} isTickBarActive={true} />);

    // Wait for expanded state to be restored from IndexedDB
    const collapseText = await screen.findByText('Collapse');
    expect(collapseText).toBeTruthy();

    // Click collapse via the parent button element
    const collapseButton = collapseText.closest('[role="button"]')!;
    act(() => {
      fireEvent.click(collapseButton);
    });

    expect(mockSetPreference).toHaveBeenCalledWith('tickBarExpanded', false);
  });

  it('does not persist state on close reset', () => {
    const onClose = vi.fn();
    const { rerender } = render(<PlayViewTickBar {...defaultProps} isTickBarActive={true} onClose={onClose} />);

    mockSetPreference.mockClear();

    // Close the tick bar by rerendering with inactive
    rerender(<PlayViewTickBar {...defaultProps} isTickBarActive={false} onClose={onClose} />);

    // Should not persist the reset
    expect(mockSetPreference).not.toHaveBeenCalledWith('tickBarExpanded', false);
  });

  it('does not persist state on climb change reset', () => {
    const { rerender } = render(<PlayViewTickBar {...defaultProps} isTickBarActive={true} />);

    mockSetPreference.mockClear();

    // Change the climb — this triggers the climb-change useEffect reset
    const newClimb = { ...mockClimb, uuid: 'climb-2' };
    rerender(<PlayViewTickBar {...defaultProps} isTickBarActive={true} currentClimb={newClimb as never} />);

    // Should not persist the automatic reset
    expect(mockSetPreference).not.toHaveBeenCalledWith('tickBarExpanded', false);
  });

  it('toggles between expand and collapse labels', async () => {
    await act(async () => {
      render(<PlayViewTickBar {...defaultProps} isTickBarActive={true} />);
    });

    // Starts collapsed
    expect(screen.getByText('Expand')).toBeTruthy();

    // Click expand
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Expand tick bar'));
    });

    await waitFor(() => {
      expect(screen.getByText('Collapse')).toBeTruthy();
    });
    expect(screen.queryByText('Expand')).toBeNull();

    // Click collapse
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Collapse tick bar'));
    });

    await waitFor(() => {
      expect(screen.getByText('Expand')).toBeTruthy();
    });
    expect(screen.queryByText('Collapse')).toBeNull();
  });

  it('calls onClose when close button is clicked', () => {
    const onClose = vi.fn();
    render(<PlayViewTickBar {...defaultProps} isTickBarActive={true} onClose={onClose} />);

    const closeButton = screen.getByLabelText('Close tick bar');
    fireEvent.click(closeButton);

    expect(onClose).toHaveBeenCalledOnce();
  });
});
