import React from 'react';
import { describe, it, expect, vi } from 'vite-plus/test';
import { renderToString } from 'react-dom/server';
import { tFromCatalog } from '@/app/__test-helpers__/i18n-mock';
import type { SessionDetail, SessionDetailTick } from '@boardsesh/shared-schema';
import type { SessionWorkoutResult } from '@boardsesh/graphql/operations/session-workouts';
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

vi.mock('@/app/hooks/use-session-workouts', () => ({
  useSessionWorkouts: ({ initialData }: { initialData?: unknown[] | null }) => initialData ?? [],
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
    // The V half of a "6b/V4" label, as the default V-grade format reads it.
    formatGrade: (difficulty: string | null | undefined) => difficulty?.split('/').pop() ?? null,
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

  describe('a workout session', () => {
    const climbFields = { boardType: 'kilter', layoutId: 1, frames: 'p1080r15', renderBoard: null, isMirror: null };
    const workout: SessionWorkoutResult = {
      userId: 'user-1',
      displayName: 'Test User',
      avatarUrl: null,
      offPlan: 1,
      updatedAt: '2024-01-15T12:00:00.000Z',
      stages: [
        {
          id: 'warm',
          kind: 'warmUp',
          isCoolDown: false,
          targetGrade: null,
          repsPerSet: null,
          sets: null,
          intervalSeconds: null,
          restSeconds: null,
          tally: { sent: 1, attempts: 0, skipped: 1, climbs: 2 },
          climbs: [
            {
              ...climbFields,
              queueItemUuid: 'q1',
              climbUuid: 'CLIMB1',
              angle: 40,
              name: 'Crimp Ladder',
              grade: '6a/V3',
              reps: ['SEND'],
              skipped: false,
            },
            {
              ...climbFields,
              queueItemUuid: 'q2',
              climbUuid: 'SKIPPED1',
              angle: 40,
              name: 'Slab Stroll',
              grade: '5c/V2',
              reps: [],
              skipped: true,
            },
          ],
        },
        {
          id: 'main',
          kind: 'fourByFour',
          isCoolDown: false,
          targetGrade: '6b/V4',
          repsPerSet: 4,
          sets: 1,
          intervalSeconds: null,
          restSeconds: 60,
          tally: { sent: 3, attempts: 1, skipped: 0, climbs: 1 },
          climbs: [
            {
              ...climbFields,
              queueItemUuid: 'q3',
              climbUuid: 'CLIMB4X4',
              angle: 40,
              name: 'Power Line',
              grade: '6b/V4',
              reps: ['FLASH', 'SEND', 'ATTEMPT', 'SEND'],
              skipped: false,
            },
          ],
        },
      ],
    };
    const ticks = [
      makeTick({ uuid: 't-warm', climbUuid: 'CLIMB1', climbedAt: '2024-01-15T10:00:00.000Z' }),
      ...['flash', 'send', 'attempt', 'send'].map((status, index) =>
        makeTick({
          uuid: `t-4x4-${index}`,
          climbUuid: 'CLIMB4X4',
          climbName: 'Power Line',
          status: status as SessionDetailTick['status'],
          climbedAt: `2024-01-15T10:1${index}:00.000Z`,
        }),
      ),
      makeTick({
        uuid: 't-off',
        climbUuid: 'OFFPLAN',
        climbName: 'Bonus Boulder',
        climbedAt: '2024-01-15T11:00:00.000Z',
      }),
      makeTick({
        uuid: 't-crew',
        userId: 'user-2',
        climbUuid: 'CREW1',
        climbName: 'Crew Pick',
        climbedAt: '2024-01-15T11:05:00.000Z',
      }),
    ];

    it('lists the climbs block by block with the workout line in the overview', () => {
      const html = renderToString(
        <SessionDetailContent session={makeSession(ticks)} sessionId="session-1" workouts={[workout]} />,
      );
      const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

      expect(text).toContain('Workout · 4x4 at V4 · 2 blocks');
      // Block headers: name, detail line, tally in ticks.
      expect(text).toContain('Warm-up V3–V2 · 2 climbs');
      expect(text).toContain('1 sent · 1 skipped');
      expect(text).toContain('4x4 at V4');
      expect(text).toContain('4 reps × 1 set');
      expect(text).toContain('3 sent · 1 attempt');
      // One row per set with its reps; the skipped climb still has a row.
      expect(text).toContain('Set 1');
      expect(text).toContain('3 of 4');
      expect(text).toContain('Skipped');
      expect(html).toContain('slab-stroll-SKIPPED1');
      // What matched no block, and the crew's.
      expect(text).toContain('Off plan');
      expect(text).toContain('Bonus Boulder');
      expect(text).toContain('The crew');
      expect(text.indexOf('Warm-up')).toBeLessThan(text.indexOf('Off plan'));
      expect(text.indexOf('Off plan')).toBeLessThan(text.indexOf('The crew'));
    });

    it("places ticks by the server's uuids: a crewmate's go on a planned climb stays with the crew", () => {
      const withUuids: SessionWorkoutResult = {
        ...workout,
        offPlanTickUuids: ['t-off'],
        stages: workout.stages.map((stage) => ({
          ...stage,
          climbs: stage.climbs.map((climb) => ({
            ...climb,
            tickUuids:
              climb.climbUuid === 'CLIMB1'
                ? ['t-warm']
                : climb.climbUuid === 'CLIMB4X4'
                  ? ['t-4x4-0', 't-4x4-1', 't-4x4-2', 't-4x4-3']
                  : [],
          })),
        })),
      };
      const crewOnPlanned = makeTick({
        uuid: 't-crew-planned',
        userId: 'user-2',
        climbUuid: 'CLIMB1',
        climbedAt: '2024-01-15T09:00:00.000Z',
      });
      const html = renderToString(
        <SessionDetailContent
          session={makeSession([...ticks, crewOnPlanned])}
          sessionId="session-1"
          workouts={[withUuids]}
        />,
      );
      const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
      const crewSection = text.slice(text.indexOf('The crew'));

      expect(text).toContain('3 of 4');
      expect(crewSection).toContain('Crimp Ladder');
      expect(crewSection).toContain('Crew Pick');
    });

    it('keeps the flat list without a workout', () => {
      const html = renderToString(
        <SessionDetailContent session={makeSession(ticks)} sessionId="session-1" workouts={[]} />,
      );
      expect(html).not.toContain('Off plan');
      expect(html).not.toContain('session-workout-line');
    });
  });
});
