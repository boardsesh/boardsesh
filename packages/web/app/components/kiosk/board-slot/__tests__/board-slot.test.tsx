import { beforeEach, describe, it, expect, vi } from 'vite-plus/test';
import { render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { BoardPresenceClimb } from '@boardsesh/shared-schema';
import type { BoardImageDetails } from '@/app/lib/types';
import BoardSlot from '../board-slot';

// Presence is driven per test: null is the SSR/pre-subscription state, where
// the server-seeded raster renders before any live frames arrive.
const presenceSnapshot = vi.hoisted(() => ({
  current: null as {
    currentClimb: (Partial<BoardPresenceClimb> & { frames: string }) | null;
    history: Array<Partial<BoardPresenceClimb> & { frames: string }>;
  } | null,
}));
vi.mock('@/app/components/kiosk/presence/use-kiosk-board-presence', () => ({
  useKioskBoardPresence: () => presenceSnapshot.current,
}));
vi.mock('@/app/components/kiosk/board-slot/board-identity', () => ({
  default: ({ climb, lastLitClimb }: { climb: BoardPresenceClimb | null; lastLitClimb: BoardPresenceClimb | null }) => (
    <div data-testid="board-identity" data-current-grade={climb?.grade} data-last-grade={lastLitClimb?.grade} />
  ),
}));
const executeGrades = vi.hoisted(() => vi.fn());
vi.mock('@/app/lib/graphql/client', () => ({ executeGraphQL: executeGrades }));
vi.mock('@/app/components/kiosk/board-slot/board-install-qr', () => ({
  default: ({ slug }: { slug: string }) => <div data-testid="install-qr" data-slug={slug} />,
}));

const boardDetails = { board_name: 'kilter', layout_id: 1, size_id: 10, set_ids: [1, 20] } as BoardImageDetails;

beforeEach(() => {
  presenceSnapshot.current = null;
  executeGrades.mockReset();
});

function renderSlot(overrides: Partial<React.ComponentProps<typeof BoardSlot>> = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
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
    { wrapper: ({ children }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider> },
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

  it('switches a lit climb to the light field immediately when the kiosk theme changes', () => {
    presenceSnapshot.current = { currentClimb: { frames: 'p1r12,p2r13' }, history: [] };
    const { rerender } = renderSlot();
    const image = screen.getByRole('presentation', { hidden: true });
    const darkUrl = new URL(image.getAttribute('src')!, 'https://www.boardsesh.com');
    expect(darkUrl.searchParams.get('field_color')).toBe('#181225');

    rerender(
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
        theme="light"
      />,
    );
    const lightUrl = new URL(image.getAttribute('src')!, 'https://www.boardsesh.com');
    expect(lightUrl.searchParams.get('field_color')).toBe('#FFFFFF');
    expect(lightUrl.searchParams.get('frames')).toBe(darkUrl.searchParams.get('frames'));
    expect(lightUrl.href).not.toBe(darkUrl.href);
  });

  it('keeps the light field after a clear-wall live update', () => {
    presenceSnapshot.current = { currentClimb: null, history: [{ frames: 'p1r12' }] };
    renderSlot({ theme: 'light' });
    const imageUrl = new URL(
      screen.getByRole('presentation', { hidden: true }).getAttribute('src')!,
      'https://www.boardsesh.com',
    );
    expect(imageUrl.searchParams.get('frames')).toBe('');
    expect(imageUrl.searchParams.get('field_color')).toBe('#FFFFFF');
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

describe('BoardSlot Aurora identity grades', () => {
  const imported: BoardPresenceClimb = {
    climbUuid: 'aurora-climb',
    source: 'aurora',
    name: 'Catalog climb',
    frames: 'p1r12',
    angle: null,
    grade: null,
    seq: 1,
    sentAt: '2026-11-17T12:00:00.123456Z',
  };
  it.each([false, true])('projects the configured-angle grade when the wall is idle: %s', async (idle) => {
    presenceSnapshot.current = {
      currentClimb: idle ? null : { ...imported, frames: 'p1r12' },
      history: [{ ...imported, frames: 'p1r12' }],
    };
    executeGrades.mockResolvedValue({
      boardPresenceClimbGrades: [
        { uuid: 'aurora-climb', difficulty: '7a/V6', boardseshDifficulty: null, boardseshConfidence: null },
      ],
    });
    renderSlot({ boardUuid: 'board-link', angle: 45 });
    await waitFor(() => expect(screen.getByTestId('board-identity').getAttribute('data-last-grade')).toBe('7a/V6'));
    expect(screen.getByTestId('board-identity').getAttribute('data-current-grade')).toBe(idle ? null : '7a/V6');
    expect(executeGrades.mock.calls[0][1]).toMatchObject({
      boardId: 1,
      boardUuid: 'board-link',
      angle: 45,
      climbUuids: ['aurora-climb'],
    });
  });
});
