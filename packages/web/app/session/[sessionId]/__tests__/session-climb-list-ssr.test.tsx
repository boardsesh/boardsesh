import React from 'react';
import { describe, it, expect, vi } from 'vite-plus/test';
import { renderToString } from 'react-dom/server';
import { tFromCatalog } from '@/app/__test-helpers__/i18n-mock';
import type { SessionDetail, SessionDetailTick } from '@boardsesh/shared-schema';
import SessionDetailContent from '../session-detail-content';

/**
 * The share page's headline promise: the HTML a crawler (or anyone pasting the
 * link) receives already carries one real climb anchor per logged climb,
 * pointing at the board the tick was logged on.
 *
 * Neither `@/app/components/climb-list/static-climb-list` nor
 * `@/app/hooks/use-board-details-map` is mocked here — the sibling
 * `session/__tests__/session-detail-content.test.tsx` stubs both, so nothing
 * over there would notice if the anchors stopped reaching the HTML or if every
 * row collapsed onto one board. `@tanstack/react-virtual` is real too: the
 * list's `initialRect` is the only reason the virtualizer yields rows on the
 * server at all.
 */
vi.mock('react-i18next', () => ({
  useTranslation: (ns?: string) => ({
    t: (key: string, options?: Record<string, unknown>) => tFromCatalog(ns, key, options),
    i18n: { language: 'en-US' },
  }),
  Trans: ({ children }: { children?: React.ReactNode }) => children ?? null,
}));

vi.mock('next/navigation', () => ({
  usePathname: () => '/session/session-1',
}));

vi.mock('@/app/components/i18n/locale-link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));

vi.mock('next-auth/react', () => ({
  useSession: () => ({ data: null, status: 'unauthenticated' }),
}));

vi.mock('@/app/hooks/use-session-detail', () => ({
  useSessionDetail: ({ initialData }: { initialData: unknown }) => ({ session: initialData ?? null, isLoading: false }),
}));

vi.mock('@/app/hooks/use-my-boards', () => ({
  useMyBoards: () => ({ boards: [], isLoading: false }),
}));

vi.mock('@/app/hooks/use-delete-tick', () => ({
  useDeleteTick: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock('@/app/hooks/use-grade-format', () => ({
  useGradeFormat: () => ({
    gradeFormat: 'v-grade',
    formatGrade: (difficulty: string | null | undefined) => difficulty ?? null,
    getGradeColor: () => '#888',
    loaded: true,
  }),
}));

vi.mock('@/app/components/providers/snackbar-provider', () => ({
  useSnackbar: () => ({ showMessage: vi.fn() }),
}));

vi.mock('@/app/lib/share-utils', () => ({ shareWithFallback: vi.fn() }));

vi.mock('@/app/components/social/vote-button', () => ({ default: () => null }));
vi.mock('@/app/components/social/comment-section', () => ({ default: () => null }));
vi.mock('@/app/components/social/vote-summary-context', () => ({
  VoteSummaryProvider: ({ children }: { children: React.ReactNode }) => children,
  useVoteSummaryContext: () => null,
}));

// The board art is irrelevant to the anchors, and the canvas path has no
// server-side equivalent.
vi.mock('@/app/components/board-renderer/board-image-layers', () => ({ default: () => null }));
vi.mock('@/app/components/board-renderer/board-canvas-renderer', () => ({ default: () => null }));
vi.mock('@/app/lib/board-render-worker/worker-manager', () => ({ useCanvasRendererReady: () => false }));

function makeTick(overrides: Partial<SessionDetailTick> = {}): SessionDetailTick {
  return {
    uuid: 'tick-1',
    userId: 'user-1',
    climbUuid: 'CLIMB1',
    climbName: 'Crimp Ladder',
    boardType: 'kilter',
    layoutId: 1,
    angle: 40,
    status: 'send',
    attemptCount: 1,
    difficulty: 20,
    difficultyName: 'V5',
    quality: 3,
    isMirror: false,
    isBenchmark: false,
    isNoMatch: false,
    comment: null,
    frames: 'p1080r15',
    setterUsername: 'setter1',
    climbedAt: '2024-01-15T10:30:00.000Z',
    upvotes: 0,
    ...overrides,
  };
}

function makeSession(ticks: SessionDetailTick[]): SessionDetail {
  return {
    sessionId: 'session-1',
    sessionType: 'party',
    sessionName: 'Tuesday Sesh',
    ownerUserId: 'user-1',
    participants: [{ userId: 'user-1', displayName: 'Test User', avatarUrl: null, sends: 1, flashes: 0, attempts: 0 }],
    totalSends: 1,
    totalFlashes: 0,
    totalAttempts: 0,
    tickCount: ticks.length,
    gradeDistribution: [],
    boardTypes: ['kilter'],
    hardestGrade: 'V5',
    firstTickAt: '2024-01-15T10:00:00.000Z',
    lastTickAt: '2024-01-15T12:00:00.000Z',
    durationMinutes: 120,
    goal: null,
    ticks,
    upvotes: 0,
    downvotes: 0,
    voteScore: 0,
    commentCount: 0,
  };
}

function serverHrefs(ticks: SessionDetailTick[]): string[] {
  const html = renderToString(<SessionDetailContent session={makeSession(ticks)} />);
  return [...html.matchAll(/href="([^"]+)"/g)].map((match) => match[1]);
}

describe('session climb list server render', () => {
  /**
   * Kilter layout 1 carries two "12 x 12" squares — id 10 ("with kickboard")
   * and id 27 ("without kickboard") — that both name-slug to `12x12-square`.
   * The tick's `renderBoard` holds the numeric ids of the wall it was logged
   * on, so a size-27 climber's row has to carry the qualified slug.
   */
  it('links a session climb to the board its tick was logged on', () => {
    const hrefs = serverHrefs([makeTick({ renderBoard: { layoutId: 1, sizeId: 27, setIds: [1, 20] } })]);

    expect(hrefs).toContain('/kilter/original/12x12-square-without-kickboard/screw_bolt/40/view/crimp-ladder-CLIMB1');
  });

  /**
   * The negative control for the case above: without the logged board the page
   * only knows the layout, and lands on its largest size. If the `renderBoard`
   * threading is dropped, the size-27 case above silently becomes this URL.
   */
  it('falls back to the layout default when the tick carries no logged board', () => {
    const hrefs = serverHrefs([makeTick({ renderBoard: null })]);

    expect(hrefs).toContain('/kilter/original/16x12-super-wide/screw_bolt/40/view/crimp-ladder-CLIMB1');
  });

  it('draws each climber on their own board in a mixed-board sesh', () => {
    const hrefs = serverHrefs([
      makeTick({ renderBoard: { layoutId: 1, sizeId: 27, setIds: [1, 20] } }),
      makeTick({
        uuid: 'tick-2',
        userId: 'user-2',
        climbUuid: 'CLIMB2',
        climbName: 'Sloper Traverse',
        renderBoard: { layoutId: 1, sizeId: 10, setIds: [1, 20] },
      }),
    ]);

    expect(hrefs).toContain('/kilter/original/12x12-square-without-kickboard/screw_bolt/40/view/crimp-ladder-CLIMB1');
    expect(hrefs).toContain('/kilter/original/12x12-square/screw_bolt/40/view/sloper-traverse-CLIMB2');
  });

  /**
   * A tick whose catalog lookup missed arrives with no name, no layout and no
   * frames. Every part of a climb URL for it would be invented, so the row
   * ships without an anchor rather than as a link that 404s.
   */
  it('renders a climb the catalog does not know without a link', () => {
    const ticks = [
      makeTick({ renderBoard: { layoutId: 1, sizeId: 27, setIds: [1, 20] } }),
      makeTick({
        uuid: 'tick-2',
        climbUuid: 'MISSINGCLIMB',
        climbName: null,
        layoutId: null,
        frames: null,
        renderBoard: null,
      }),
    ];
    const html = renderToString(<SessionDetailContent session={makeSession(ticks)} />);
    const hrefs = [...html.matchAll(/href="([^"]+)"/g)].map((match) => match[1]);

    expect(html).toContain('Unknown Climb');
    expect(hrefs.some((href) => href.includes('MISSINGCLIMB'))).toBe(false);
    expect(hrefs).toContain('/kilter/original/12x12-square-without-kickboard/screw_bolt/40/view/crimp-ladder-CLIMB1');
  });
});
