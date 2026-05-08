// @vitest-environment jsdom

import { describe, it, expect, vi } from 'vite-plus/test';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { PlayViewActionBar } from '../play-view-drawer';
import { tFromCatalog } from '@/app/__test-helpers__/i18n-mock';

vi.mock('react-i18next', () => ({
  useTranslation: (ns?: string) => ({
    t: (key: string, options?: Record<string, unknown>) => tFromCatalog(ns, key, options),
    i18n: { language: 'en-US' },
  }),
  Trans: ({ children }: { children?: React.ReactNode }) => children ?? null,
}));

// ---------------------------------------------------------------------------
// Mock heavy deps that PlayViewActionBar imports transitively.
// ---------------------------------------------------------------------------

vi.mock('@/app/components/board-page/share-button', () => ({
  ShareBoardButton: () => React.createElement('button', { 'data-testid': 'share-button' }),
}));

// MUI icons — keep as simple SVG stubs so we don't need a full MUI theme
vi.mock('@mui/icons-material/SkipPreviousOutlined', () => ({
  default: () => React.createElement('svg', { 'data-testid': 'icon-skip-prev' }),
}));
vi.mock('@mui/icons-material/SkipNextOutlined', () => ({
  default: () => React.createElement('svg', { 'data-testid': 'icon-skip-next' }),
}));
vi.mock('@mui/icons-material/SyncOutlined', () => ({
  default: () => React.createElement('svg', { 'data-testid': 'icon-mirror' }),
}));
vi.mock('@mui/icons-material/Favorite', () => ({
  default: () => React.createElement('svg', { 'data-testid': 'icon-favorited' }),
}));
vi.mock('@mui/icons-material/FavoriteBorderOutlined', () => ({
  default: () => React.createElement('svg', { 'data-testid': 'icon-unfavorited' }),
}));
vi.mock('@mui/icons-material/MoreHorizOutlined', () => ({
  default: () => React.createElement('svg', { 'data-testid': 'icon-more' }),
}));
vi.mock('@mui/icons-material/CloseOutlined', () => ({
  default: () => React.createElement('svg', { 'data-testid': 'icon-close' }),
}));
vi.mock('@mui/icons-material/FormatListBulletedOutlined', () => ({
  default: () => React.createElement('svg', { 'data-testid': 'icon-queue' }),
}));
vi.mock('@mui/icons-material/SwapHorizOutlined', () => ({
  default: () => React.createElement('svg', { 'data-testid': 'icon-switch-to-edit' }),
}));

// Import after mocks

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildProps(
  overrides: Partial<React.ComponentProps<typeof PlayViewActionBar>> = {},
): React.ComponentProps<typeof PlayViewActionBar> {
  return {
    canSwipePrevious: true,
    canSwipeNext: true,
    isMirrored: false,
    supportsMirroring: false,
    isFavorited: false,
    remainingQueueCount: 0,
    onPrevClick: vi.fn(),
    onNextClick: vi.fn(),
    onMirror: vi.fn(),
    onToggleFavorite: vi.fn(),
    onOpenActions: vi.fn(),
    onOpenQueue: vi.fn(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PlayViewActionBar', () => {
  it('renders prev and next buttons', () => {
    render(<PlayViewActionBar {...buildProps()} />);
    expect(screen.getByLabelText('Open queue')).toBeTruthy();
    expect(screen.getByTestId('icon-skip-prev')).toBeTruthy();
    expect(screen.getByTestId('icon-skip-next')).toBeTruthy();
  });

  it('disables prev button when canSwipePrevious=false', () => {
    render(<PlayViewActionBar {...buildProps({ canSwipePrevious: false })} />);
    // The icon-skip-prev button's parent IconButton should be disabled
    const prevBtn = screen.getByTestId('icon-skip-prev').closest('button');
    expect(prevBtn?.disabled).toBe(true);
  });

  it('disables next button when canSwipeNext=false', () => {
    render(<PlayViewActionBar {...buildProps({ canSwipeNext: false })} />);
    const nextBtn = screen.getByTestId('icon-skip-next').closest('button');
    expect(nextBtn?.disabled).toBe(true);
  });

  it('hides mirror button when supportsMirroring=false', () => {
    render(<PlayViewActionBar {...buildProps({ supportsMirroring: false })} />);
    expect(screen.queryByTestId('icon-mirror')).toBeNull();
  });

  it('shows mirror button when supportsMirroring=true', () => {
    render(<PlayViewActionBar {...buildProps({ supportsMirroring: true })} />);
    expect(screen.getByTestId('icon-mirror')).toBeTruthy();
  });

  it('shows unfavorited icon when isFavorited=false', () => {
    render(<PlayViewActionBar {...buildProps({ isFavorited: false })} />);
    expect(screen.getByTestId('icon-unfavorited')).toBeTruthy();
    expect(screen.queryByTestId('icon-favorited')).toBeNull();
  });

  it('shows favorited icon when isFavorited=true', () => {
    render(<PlayViewActionBar {...buildProps({ isFavorited: true })} />);
    expect(screen.getByTestId('icon-favorited')).toBeTruthy();
    expect(screen.queryByTestId('icon-unfavorited')).toBeNull();
  });

  it('calls onPrevClick when prev button clicked', () => {
    const onPrevClick = vi.fn();
    render(<PlayViewActionBar {...buildProps({ onPrevClick })} />);
    fireEvent.click(screen.getByTestId('icon-skip-prev').closest('button')!);
    expect(onPrevClick).toHaveBeenCalledOnce();
  });

  it('calls onNextClick when next button clicked', () => {
    const onNextClick = vi.fn();
    render(<PlayViewActionBar {...buildProps({ onNextClick })} />);
    fireEvent.click(screen.getByTestId('icon-skip-next').closest('button')!);
    expect(onNextClick).toHaveBeenCalledOnce();
  });

  it('calls onMirror when mirror button clicked', () => {
    const onMirror = vi.fn();
    render(<PlayViewActionBar {...buildProps({ supportsMirroring: true, onMirror })} />);
    fireEvent.click(screen.getByTestId('icon-mirror').closest('button')!);
    expect(onMirror).toHaveBeenCalledOnce();
  });

  it('calls onToggleFavorite when favorite button clicked', () => {
    const onToggleFavorite = vi.fn();
    render(<PlayViewActionBar {...buildProps({ onToggleFavorite })} />);
    fireEvent.click(screen.getByTestId('icon-unfavorited').closest('button')!);
    expect(onToggleFavorite).toHaveBeenCalledOnce();
  });

  it('calls onOpenActions when actions button clicked', () => {
    const onOpenActions = vi.fn();
    render(<PlayViewActionBar {...buildProps({ onOpenActions })} />);
    fireEvent.click(screen.getByLabelText('Climb actions'));
    expect(onOpenActions).toHaveBeenCalledOnce();
  });

  it('calls onOpenQueue when queue button clicked', () => {
    const onOpenQueue = vi.fn();
    render(<PlayViewActionBar {...buildProps({ onOpenQueue })} />);
    fireEvent.click(screen.getByLabelText('Open queue'));
    expect(onOpenQueue).toHaveBeenCalledOnce();
  });

  it('calls onSwitchToEdit when the spectate transfer button is clicked', () => {
    const onSwitchToEdit = vi.fn();
    render(<PlayViewActionBar {...buildProps({ showSwitchToEdit: true, onSwitchToEdit })} />);
    fireEvent.click(screen.getByLabelText('Switch to my pick'));
    expect(onSwitchToEdit).toHaveBeenCalledOnce();
  });

  it('shows queue badge count', () => {
    render(<PlayViewActionBar {...buildProps({ remainingQueueCount: 5 })} />);
    // MUI Badge renders the count as text
    expect(screen.getByText('5')).toBeTruthy();
  });
});
