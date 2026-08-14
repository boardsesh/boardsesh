import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { render, screen } from '@testing-library/react';
import React from 'react';
import PlaylistPreviewSquare from '../playlist-preview-square';

/**
 * The kept copy of the preview square (lifted out of `components/library/`,
 * which W-16 deletes). Same coverage as the original's suite, pointed at the
 * component the live playlists surfaces actually render.
 */

// Mock BoardImageLayers (used instead of BoardRenderer)
vi.mock('../../board-renderer/board-image-layers', () => ({
  default: () => <div data-testid="board-image-layers" />,
}));

// Mock getBoardDetailsForPlaylist
const mockGetBoardDetailsForPlaylist = vi.fn();
vi.mock('@/app/lib/board-config-for-playlist', () => ({
  getBoardDetailsForPlaylist: (...args: unknown[]) => mockGetBoardDetailsForPlaylist(...args),
}));

// Mock theme tokens
vi.mock('@/app/theme/theme-config', () => ({
  themeTokens: {
    colors: {
      primary: '#4F46E5',
      accentGreen: '#22C55E',
      purple: '#8B5CF6',
      warning: '#F59E0B',
      pink: '#EC4899',
      success: '#10B981',
      accentRose: '#F43F5E',
      amber: '#F59E0B',
    },
  },
}));

// Mock CSS modules
vi.mock('../playlist-preview-square.module.css', () => ({
  default: new Proxy(
    {},
    {
      get: (_target, prop) => String(prop),
    },
  ),
}));

const MOCK_BOARD_DETAILS = {
  board_name: 'kilter',
  layout_id: 1,
  size_id: 10,
  set_ids: [1, 20],
  images_to_holds: { 'test.png': [] },
  holdsData: [],
  edge_left: 0,
  edge_right: 100,
  edge_bottom: 0,
  edge_top: 100,
  boardWidth: 1080,
  boardHeight: 1920,
  supportsMirroring: false,
};

describe('PlaylistPreviewSquare', () => {
  beforeEach(() => {
    mockGetBoardDetailsForPlaylist.mockReset();
  });

  it('renders BoardRenderer when board details are available', () => {
    mockGetBoardDetailsForPlaylist.mockReturnValue(MOCK_BOARD_DETAILS);

    render(<PlaylistPreviewSquare boardType="kilter" layoutId={1} color="#FF6600" />);

    expect(screen.getByTestId('board-image-layers')).toBeDefined();
    expect(mockGetBoardDetailsForPlaylist).toHaveBeenCalledWith('kilter', 1);
  });

  it('does not render BoardRenderer when board details are null', () => {
    mockGetBoardDetailsForPlaylist.mockReturnValue(null);

    render(<PlaylistPreviewSquare boardType="unknown" color="#FF6600" />);

    expect(screen.queryByTestId('board-image-layers')).toBeNull();
  });

  it('renders emoji when provided', () => {
    mockGetBoardDetailsForPlaylist.mockReturnValue(MOCK_BOARD_DETAILS);

    const { container } = render(<PlaylistPreviewSquare boardType="kilter" layoutId={1} icon="🔥" color="#FF6600" />);

    const emoji = container.querySelector('.previewEmoji');
    expect(emoji).toBeDefined();
    expect(emoji?.textContent).toBe('🔥');
  });

  it('renders fallback LabelOutlined icon when no emoji is provided', () => {
    mockGetBoardDetailsForPlaylist.mockReturnValue(MOCK_BOARD_DETAILS);

    const { container } = render(<PlaylistPreviewSquare boardType="kilter" layoutId={1} color="#FF6600" />);

    // Should render the icon class, not the emoji class
    expect(container.querySelector('.previewIcon')).toBeDefined();
    expect(container.querySelector('.previewEmoji')).toBeNull();
  });

  it('renders FavoriteOutlined for isLikedClimbs', () => {
    mockGetBoardDetailsForPlaylist.mockReturnValue(MOCK_BOARD_DETAILS);

    const { container } = render(<PlaylistPreviewSquare boardType="kilter" layoutId={1} isLikedClimbs />);

    // Should NOT render the board preview for liked climbs
    expect(screen.queryByTestId('board-image-layers')).toBeNull();
    // Should have the liked gradient class
    expect(container.querySelector('.likedGradient')).toBeDefined();
  });

  it('renders frosted overlay when board preview is shown', () => {
    mockGetBoardDetailsForPlaylist.mockReturnValue(MOCK_BOARD_DETAILS);

    const { container } = render(<PlaylistPreviewSquare boardType="kilter" layoutId={1} color="#FF6600" />);

    expect(container.querySelector('.previewFrostedOverlay')).toBeDefined();
    expect(container.querySelector('.previewBoardLayer')).toBeDefined();
  });

  it('does not render frosted overlay when falling back to solid color', () => {
    mockGetBoardDetailsForPlaylist.mockReturnValue(null);

    const { container } = render(<PlaylistPreviewSquare boardType="unknown" color="#FF6600" />);

    expect(container.querySelector('.previewFrostedOverlay')).toBeNull();
    expect(container.querySelector('.previewBoardLayer')).toBeNull();
  });

  it('forwards className to container', () => {
    mockGetBoardDetailsForPlaylist.mockReturnValue(MOCK_BOARD_DETAILS);

    const { container } = render(
      <PlaylistPreviewSquare boardType="kilter" layoutId={1} color="#FF6600" className="custom-class" />,
    );

    const root = container.firstChild as HTMLElement;
    expect(root.className).toContain('custom-class');
  });

  it('uses fallback color from PLAYLIST_COLORS when no valid color is provided', () => {
    mockGetBoardDetailsForPlaylist.mockReturnValue(null);

    const { container } = render(<PlaylistPreviewSquare boardType="kilter" layoutId={1} index={0} />);

    const root = container.firstChild as HTMLElement;
    // Browser converts hex to rgb — #4F46E5 = rgb(79, 70, 229)
    expect(root.style.background).toContain('rgb(79, 70, 229)');
  });

  it('applies frosted overlay with rgba color derived from hex', () => {
    mockGetBoardDetailsForPlaylist.mockReturnValue(MOCK_BOARD_DETAILS);

    const { container } = render(<PlaylistPreviewSquare boardType="kilter" layoutId={1} color="#FF6600" />);

    const overlay = container.querySelector('.previewFrostedOverlay') as HTMLElement;
    expect(overlay.style.background).toBe('rgba(255, 102, 0, 0.45)');
  });
});
