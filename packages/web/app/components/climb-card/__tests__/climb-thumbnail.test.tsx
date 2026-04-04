import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';
import type { BoardDetails, Climb } from '@/app/lib/types';

let mockPathname = '/b/moonrise-gym/40/list';

vi.mock('next/navigation', () => ({
  usePathname: () => mockPathname,
}));

vi.mock('next/link', () => ({
  default: ({ href, children, prefetch: _prefetch, ...rest }: { href: string; children: React.ReactNode; prefetch?: boolean }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import ClimbThumbnail from '../climb-thumbnail';

const boardDetails = {
  board_name: 'kilter',
  layout_id: 1,
  size_id: 2,
  set_ids: [3, 4],
  images_to_holds: {},
  holdsData: [],
  edge_left: 0,
  edge_right: 100,
  edge_bottom: 0,
  edge_top: 100,
  boardHeight: 100,
  boardWidth: 100,
  layout_name: 'Homewall',
  size_name: '8x12 Full Ride',
  size_description: 'Main',
  set_names: ['Main Kicker', 'Aux Kicker'],
} as BoardDetails;

const climb = {
  uuid: 'ABC123',
  name: 'Moon Landing',
  angle: 40,
  setter_username: 'setter',
  description: '',
  frames: '',
  ascensionist_count: 0,
  difficulty: 'V4',
  quality_average: '3',
  stars: 0,
  difficulty_error: '0',
  benchmark_difficulty: null,
} as Climb;

describe('ClimbThumbnail', () => {
  it('preserves board-slug URL context on /b routes', () => {
    mockPathname = '/b/moonrise-gym/40/list';

    render(<ClimbThumbnail boardDetails={boardDetails} currentClimb={climb} enableNavigation />);

    const link = screen.getByTestId('climb-thumbnail-link');
    expect(link.getAttribute('href')).toBe('/b/moonrise-gym/40/view/moon-landing-ABC123');
  });

  it('falls back to canonical route format outside /b routes', () => {
    mockPathname = '/kilter/homewall/8x12-main/main-kicker_aux-kicker/40/list';

    render(<ClimbThumbnail boardDetails={boardDetails} currentClimb={climb} enableNavigation />);

    const link = screen.getByTestId('climb-thumbnail-link');
    expect(link.getAttribute('href')).toBe(
      '/kilter/homewall/8x12-main/main-kicker_aux-kicker/40/view/moon-landing-ABC123',
    );
  });
});
