import { beforeEach, describe, it, expect, vi } from 'vite-plus/test';
import { render, screen } from '@testing-library/react';
import React from 'react';
import type { BoardImageDetails } from '@/app/lib/types';
import BoardSlot from '../board-slot';

// Presence is driven per test: null is the SSR/pre-subscription state, where
// the server-seeded raster renders before any live frames arrive.
const presenceSnapshot = vi.hoisted(() => ({
  current: null as { currentClimb: { frames: string } | null; history: { frames: string }[] } | null,
}));
vi.mock('@/app/components/kiosk/presence/use-kiosk-board-presence', () => ({
  useKioskBoardPresence: () => presenceSnapshot.current,
}));
vi.mock('@/app/components/kiosk/board-slot/board-identity', () => ({
  default: () => <div data-testid="board-identity" />,
}));
vi.mock('@/app/components/kiosk/board-slot/board-install-qr', () => ({
  default: ({ slug }: { slug: string }) => <div data-testid="install-qr" data-slug={slug} />,
}));

const boardDetails = { board_name: 'kilter', layout_id: 1, size_id: 10, set_ids: [1, 20] } as BoardImageDetails;

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
    expect(screen.getByRole('presentation', { hidden: true }).getAttribute('src')).toBe('/bare.webp');
  });

  it('loads the flattened live climb from the backend renderer', () => {
    // Two frames: the image request must get the cumulative final lit state, which is
    // what the raster placeholder and the app both draw. The role codes come
    // back canonicalised (12/13 are STARTING/HAND on an older Kilter product
    // set; 42/43 are the current ones) because `toFlatFrames` round-trips
    // through the role maps — same normalisation the raster URL gets.
    presenceSnapshot.current = { currentClimb: { frames: 'p1r12,p2r13' }, history: [] };
    renderSlot();
    const imageUrl = new URL(
      screen.getByRole('presentation', { hidden: true }).getAttribute('src')!,
      'https://www.boardsesh.com',
    );
    expect(imageUrl.searchParams.get('frames')).toBe('p1r42p2r43');
    expect(imageUrl.searchParams.get('include_background')).toBe('1');
  });

  it('requests the backend bare-board render when the wall is clear', () => {
    presenceSnapshot.current = { currentClimb: null, history: [{ frames: 'p1r12' }] };
    renderSlot();
    const imageUrl = new URL(
      screen.getByRole('presentation', { hidden: true }).getAttribute('src')!,
      'https://www.boardsesh.com',
    );
    expect(imageUrl.searchParams.get('frames')).toBe('');
    expect(imageUrl.searchParams.get('include_background')).toBe('1');
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
