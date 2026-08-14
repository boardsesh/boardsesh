import React from 'react';
import { describe, it, expect, vi } from 'vite-plus/test';
import { renderToString } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { SimilarClimb } from '@boardsesh/shared-schema';
import type { BoardDetails } from '@/app/lib/types';
import SimilarClimbsList from '../similar-climbs-list';

/**
 * The claim that motivates the similar-climbs rewrite (W-15, #4369): every card
 * is now a real `<a href>` present in the FIRST server render, seeded from the
 * page's `initialClimbs`, rather than a `<button>` that swaps the queue's
 * current climb after hydration.
 *
 * Two things have to be true for the front door's "similar climbs" section to
 * be worth anything to a crawler, and neither was covered — the page-level SSR
 * suite mocks this component out entirely:
 *
 *  1. The server HTML carries one anchor per seeded climb.
 *  2. Seeding leaves React Query out of `isLoading`, so the HTML carries the
 *     cards rather than a spinner.
 *
 * The GraphQL client is NOT mocked with a working implementation on purpose: if
 * the component ever fetches instead of using the seed, the query function
 * below throws and the section renders its error state rather than the links.
 *
 * The last case covers the other half of the seeding contract:
 * `initialDataUpdatedAt`, without which React Query stamps `dataUpdatedAt = 0`,
 * every staleTime loses to `Date.now() - 0`, and the client re-runs a resolver
 * that is rate-limited 30/min against the web server's single IP the moment the
 * front door hydrates.
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
const graphqlRequest = vi.fn(() => {
  throw new Error('the page seeds similar climbs via initialClimbs — this must not run');
});
vi.mock('@/app/lib/graphql/client', () => ({
  createGraphQLHttpClient: () => ({ request: graphqlRequest }),
}));

function makeSimilarClimb(index: number): SimilarClimb {
  return {
    uuid: `SIMILAR${index}`,
    name: `Similar Boulder ${index}`,
    layoutId: 1,
    angle: 40,
    frames: `p${index}r14`,
    difficultyName: 'V4',
    setterUsername: 'setter',
    qualityAverage: 3,
    ascensionistCount: 7,
    compatibleSizeIds: [10],
  } as unknown as SimilarClimb;
}

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

const seededClimbs = Array.from({ length: 6 }, (_, index) => makeSimilarClimb(index));

function seededList(queryClient: QueryClient) {
  return (
    <QueryClientProvider client={queryClient}>
      <SimilarClimbsList
        boardType="kilter"
        layoutId={1}
        viewerBoardDetails={makeBoardDetails()}
        climbUuid="ORIGIN-CLIMB"
        angle={40}
        initialClimbs={seededClimbs}
      />
    </QueryClientProvider>
  );
}

function makeQueryClient() {
  // `retry: false` so the negative control (the throwing client) surfaces
  // immediately rather than being swallowed by React Query's retry loop.
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function renderSeededList() {
  return renderToString(seededList(makeQueryClient()));
}

describe('SimilarClimbsList server render', () => {
  it('emits one crawlable anchor per seeded climb, not a spinner', () => {
    const html = renderSeededList();

    const anchors = html.match(/href="\/kilter\/[^"]*\/view\/[^"]*"/g) ?? [];
    expect(anchors).toHaveLength(seededClimbs.length);
    expect(html).not.toContain('MuiCircularProgress');
  });

  it('points each anchor at the canonical config-tuple view URL for the viewer board', () => {
    const html = renderSeededList();

    expect(html).toContain('href="/kilter/original/12x12-square/screw_bolt/40/view/similar-boulder-0-SIMILAR0"');
    // Non-vacuous: the LAST seeded card is there too, so this isn't one anchor
    // plus a client-side tail.
    expect(html).toContain('/view/similar-boulder-5-SIMILAR5');
  });

  it('renders no <button> cards — the queue-activation path is gone', () => {
    const html = renderSeededList();

    expect(html).not.toMatch(/<button/);
  });

  it('lands the seed in the cache fresh, so hydration does not refetch it', async () => {
    graphqlRequest.mockClear();
    const { render, screen, cleanup } = await import('@testing-library/react');
    const queryClient = makeQueryClient();

    render(seededList(queryClient));
    await screen.findByText('Similar Boulder 0');

    const [seededQuery] = queryClient.getQueryCache().findAll({ queryKey: ['similarClimbs'] });
    // A seeded query stamped `dataUpdatedAt = 0` would lose every staleTime
    // comparison to `Date.now() - 0` and refetch on hydration, re-running a
    // resolver rate-limited 30/min behind the web server's single IP. This
    // asserts the freshness, not which option supplies it.
    expect(seededQuery?.state.dataUpdatedAt).toBeGreaterThan(0);
    expect(seededQuery?.isStale()).toBe(false);
    expect(graphqlRequest).not.toHaveBeenCalled();
    cleanup();
  });
});
