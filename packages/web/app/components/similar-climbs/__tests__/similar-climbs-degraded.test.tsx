import React from 'react';
import { describe, expect, it, vi } from 'vite-plus/test';
import { renderToString } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { SimilarClimb } from '@boardsesh/shared-schema';
import type { BoardDetails } from '@/app/lib/types';
import SimilarClimbsList from '../similar-climbs-list';

/**
 * The recovery half of #4968.
 *
 * When the front door's server-side read times out it hands this list NO seed,
 * on purpose. React Query stamps a seeded query fresh for the full staleTime,
 * so seeding it with `[]` would pin "No similar climbs on this layout." to the
 * page for the reader's whole visit and never fetch. Unseeded, the browser
 * fetches the section itself the moment it hydrates.
 *
 * That leaves one server render with nothing to show, which on an indexed page
 * may not be a bare spinner — a crawler reads the loading state as the
 * section's final content. `pendingMessage` is the prose that stands there
 * instead. `similar-climbs-ssr.test.tsx` covers the seeded (healthy) path.
 */

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/app/components/i18n/locale-link', () => ({
  default: ({ href, children, className }: { href: string; children: React.ReactNode; className?: string }) => (
    <a href={href} className={className}>
      {children}
    </a>
  ),
}));

vi.mock('@/app/components/board-renderer/board-image-layers', () => ({ default: () => null }));
vi.mock('@/app/components/board-renderer/board-canvas-renderer', () => ({ default: () => null }));
vi.mock('@/app/lib/board-render-worker/worker-manager', () => ({ useCanvasRendererReady: () => false }));
vi.mock('@/app/hooks/use-is-dark-mode', () => ({ useIsDarkMode: () => false }));
vi.mock('@/app/hooks/use-grade-format', () => ({
  useGradeFormat: () => ({ formatGrade: (grade?: string) => grade, getGradeColor: () => undefined }),
}));

const graphqlRequest = vi.fn();
vi.mock('@/app/lib/graphql/client', () => ({
  createGraphQLHttpClient: () => ({ request: graphqlRequest }),
}));

const PENDING_MESSAGE = 'frontDoor.similar.unavailable';

function makeBoardDetails(): BoardDetails {
  return {
    board_name: 'kilter',
    layout_id: 1,
    size_id: 10,
    set_ids: [1, 20],
    layout_name: 'Kilter Board Original',
    size_name: '12 x 12',
    size_description: 'Commercial',
    set_names: ['Bolt Ons', 'Screw Ons'],
    images_to_holds: {},
    holdsData: {},
    boardHeight: 100,
    boardWidth: 100,
  } as unknown as BoardDetails;
}

function makeSimilarClimb(): SimilarClimb {
  return {
    uuid: 'RECOVERED0',
    name: 'Recovered Boulder',
    layoutId: 1,
    angle: 40,
    frames: 'p1r14',
    difficultyName: 'V4',
    setterUsername: 'setter',
    qualityAverage: 3,
    ascensionistCount: 7,
    compatibleSizeIds: [10],
  } as unknown as SimilarClimb;
}

function degradedList(queryClient: QueryClient) {
  return (
    <QueryClientProvider client={queryClient}>
      <SimilarClimbsList
        boardType="kilter"
        layoutId={1}
        viewerBoardDetails={makeBoardDetails()}
        climbUuid="ORIGIN-CLIMB"
        angle={40}
        emptyMessage="similarClimbs.emptyOnLayout"
        pendingMessage={PENDING_MESSAGE}
      />
    </QueryClientProvider>
  );
}

function makeQueryClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

describe('SimilarClimbsList with no seed and a pending message', () => {
  it('server-renders the pending prose rather than a spinner', () => {
    graphqlRequest.mockImplementation(async () => ({ similarClimbs: [] }));
    const html = renderToString(degradedList(makeQueryClient()));

    expect(html).toContain(PENDING_MESSAGE);
    expect(html).not.toContain('MuiCircularProgress');
    // Non-vacuous: the degraded copy must not be the empty copy. The whole
    // point is that they are different claims.
    expect(html).not.toContain('similarClimbs.emptyOnLayout');
  });

  it('fetches from the browser on hydration and swaps the real climbs in', async () => {
    graphqlRequest.mockClear();
    graphqlRequest.mockImplementation(async () => ({ similarClimbs: [makeSimilarClimb()] }));
    const { render, screen, cleanup } = await import('@testing-library/react');

    render(degradedList(makeQueryClient()));
    await screen.findByText('Recovered Boulder');

    // One fetch, from the reader's own browser: the section the server could
    // not resolve recovers without the reader doing anything.
    expect(graphqlRequest).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(PENDING_MESSAGE)).toBeNull();
    cleanup();
  });

  it('keeps the spinner for every caller that passes no pending message', () => {
    graphqlRequest.mockImplementation(async () => ({ similarClimbs: [] }));
    const html = renderToString(
      <QueryClientProvider client={makeQueryClient()}>
        <SimilarClimbsList
          boardType="kilter"
          layoutId={1}
          viewerBoardDetails={makeBoardDetails()}
          climbUuid="ORIGIN-CLIMB"
          angle={40}
        />
      </QueryClientProvider>,
    );

    expect(html).toContain('MuiCircularProgress');
  });
});
