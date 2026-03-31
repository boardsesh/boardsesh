import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';
import type { BoardDetails, Climb } from '@/app/lib/types';

// Mock IntersectionObserver so the lazy-load gate immediately fires
beforeEach(() => {
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      private cb: IntersectionObserverCallback;
      constructor(cb: IntersectionObserverCallback) {
        this.cb = cb;
      }
      observe() {
        // Trigger immediately with isIntersecting: true
        this.cb(
          [{ isIntersecting: true } as IntersectionObserverEntry],
          this as unknown as IntersectionObserver,
        );
      }
      disconnect() {}
      unobserve() {}
    },
  );
});

let mockPathname = '/b/moonrise-gym/40/list';

vi.mock('next/navigation', () => ({
  usePathname: () => mockPathname,
}));

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>{children}</a>
  ),
}));

vi.mock('../../board-renderer/board-renderer', () => ({
  default: () => <div data-testid="board-renderer" />,
}));

import ClimbThumbnail from '../climb-thumbnail';
import { FeatureFlagsProvider } from '../../providers/feature-flags-provider';

const defaultFlags = { 'rust-svg-rendering': false as const };

function renderWithFlags(ui: React.ReactElement) {
  return render(
    <FeatureFlagsProvider flags={defaultFlags}>{ui}</FeatureFlagsProvider>,
  );
}

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

describe('ClimbThumbnail placeholder', () => {
  beforeEach(() => {
    // Override: IntersectionObserver that does NOT fire, so the placeholder stays visible
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        observe() {}
        disconnect() {}
        unobserve() {}
      },
    );
  });

  it('applies maxHeight matching BoardRenderer default (10vh) to prevent layout shift', () => {
    const { container } = renderWithFlags(
      <ClimbThumbnail
        boardDetails={boardDetails}
        currentClimb={climb}
      />,
    );

    const placeholder = container.firstElementChild as HTMLElement;
    expect(placeholder.style.maxHeight).toBe('10vh');
    expect(placeholder.style.aspectRatio).toBe('100/100');
  });

  it('uses custom maxHeight when provided', () => {
    const { container } = renderWithFlags(
      <ClimbThumbnail
        boardDetails={boardDetails}
        currentClimb={climb}
        maxHeight="80px"
      />,
    );

    const placeholder = container.firstElementChild as HTMLElement;
    expect(placeholder.style.maxHeight).toBe('80px');
  });

  it('reflects board aspect ratio in placeholder', () => {
    const tallBoard = { ...boardDetails, boardWidth: 548, boardHeight: 868 };
    const { container } = renderWithFlags(
      <ClimbThumbnail
        boardDetails={tallBoard}
        currentClimb={climb}
      />,
    );

    const placeholder = container.firstElementChild as HTMLElement;
    expect(placeholder.style.aspectRatio).toBe('548/868');
    expect(placeholder.style.maxHeight).toBe('10vh');
  });
});

describe('ClimbThumbnail', () => {
  it('preserves board-slug URL context on /b routes', () => {
    mockPathname = '/b/moonrise-gym/40/list';

    renderWithFlags(
      <ClimbThumbnail
        boardDetails={boardDetails}
        currentClimb={climb}
        enableNavigation
      />,
    );

    const link = screen.getByTestId('climb-thumbnail-link');
    expect(link.getAttribute('href')).toBe('/b/moonrise-gym/40/view/moon-landing-ABC123');
  });

  it('falls back to canonical route format outside /b routes', () => {
    mockPathname = '/kilter/homewall/8x12-main/main-kicker_aux-kicker/40/list';

    renderWithFlags(
      <ClimbThumbnail
        boardDetails={boardDetails}
        currentClimb={climb}
        enableNavigation
      />,
    );

    const link = screen.getByTestId('climb-thumbnail-link');
    expect(link.getAttribute('href')).toBe('/kilter/homewall/8x12-main/main-kicker_aux-kicker/40/view/moon-landing-ABC123');
  });
});
