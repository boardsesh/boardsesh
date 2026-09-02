import { beforeEach, describe, it, expect, vi } from 'vite-plus/test';
import { render, screen } from '@testing-library/react';
import React from 'react';
import type { BoardDetails } from '@/app/lib/types';
import BoardSlot from '../board-slot';

// Presence is driven per test: null is the SSR/pre-subscription state, where
// the raster <img> branch renders and the canvas stays out of the tree.
const presenceSnapshot = vi.hoisted(() => ({
  current: null as { currentClimb: { frames: string } | null; history: { frames: string }[] } | null,
}));
vi.mock('@/app/components/kiosk/presence/use-kiosk-board-presence', () => ({
  useKioskBoardPresence: () => presenceSnapshot.current,
}));
vi.mock('@/app/components/board-renderer/board-canvas-renderer', () => ({
  default: ({ frames }: { frames: string }) => <div data-testid="board-canvas" data-frames={frames} />,
}));
vi.mock('@/app/components/kiosk/board-slot/board-identity', () => ({
  default: () => <div data-testid="board-identity" />,
}));
vi.mock('@/app/components/kiosk/board-slot/board-install-qr', () => ({
  default: ({ slug }: { slug: string }) => <div data-testid="install-qr" data-slug={slug} />,
}));

const boardDetails = { board_name: 'kilter' } as unknown as BoardDetails;

beforeEach(() => {
  presenceSnapshot.current = null;
});

function renderSlot(overrides: Partial<React.ComponentProps<typeof BoardSlot>> = {}) {
  return render(
    <BoardSlot
      boardId={1}
      boardName="Main Kilter"
      angle={40}
      boardDetails={boardDetails}
      initialClimb={null}
      initialClimbImageUrl={null}
      bareBoardImageUrl="/bare.webp"
      slug="main-kilter"
      showInstallQr
      {...overrides}
    />,
  );
}

describe('BoardSlot art source', () => {
  it('paints the server raster before the live feed answers', () => {
    renderSlot({ bareBoardImageUrl: '/bare.webp' });
    expect(screen.queryByTestId('board-canvas')).toBeNull();
    expect(screen.getByRole('presentation', { hidden: true }).getAttribute('src')).toBe('/bare.webp');
  });

  it('hands the live climb to the canvas renderer, flattened', () => {
    // Two frames: the canvas must get the cumulative final lit state, which is
    // what the raster placeholder and the app both draw. The role codes come
    // back canonicalised (12/13 are STARTING/HAND on an older Kilter product
    // set; 42/43 are the current ones) because `toFlatFrames` round-trips
    // through the role maps — same normalisation the raster URL gets.
    presenceSnapshot.current = { currentClimb: { frames: 'p1r12,p2r13' }, history: [] };
    renderSlot();
    expect(screen.getByTestId('board-canvas').getAttribute('data-frames')).toBe('p1r42p2r43');
  });

  it('draws a bare board on the canvas when the wall is clear', () => {
    presenceSnapshot.current = { currentClimb: null, history: [{ frames: 'p1r12' }] };
    renderSlot();
    expect(screen.getByTestId('board-canvas').getAttribute('data-frames')).toBe('');
  });
});

describe('BoardSlot install QR', () => {
  it('renders the QR (with the board slug) when the toggle is on and a slug is present', () => {
    renderSlot();
    expect(screen.getByTestId('install-qr').getAttribute('data-slug')).toBe('main-kilter');
  });

  it('hides the QR when the toggle is off', () => {
    renderSlot({ showInstallQr: false });
    expect(screen.queryByTestId('install-qr')).toBeNull();
  });

  it('hides the QR when the slug is empty', () => {
    renderSlot({ slug: '' });
    expect(screen.queryByTestId('install-qr')).toBeNull();
  });
});
