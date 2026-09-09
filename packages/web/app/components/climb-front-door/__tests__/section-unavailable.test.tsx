import React from 'react';
import { describe, expect, it, vi } from 'vite-plus/test';
import { renderToString } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { SimilarClimb } from '@boardsesh/shared-schema';
import { resolveServerTree } from '@/app/lib/__tests__/helpers/resolve-server-tree';
import type { FrontDoorSection } from '@/app/lib/data/front-door-data.server';
import type { BetaLink } from '@/app/lib/beta-video-url';
import type { BoardDetails, Climb } from '@/app/lib/types';

/**
 * #4968: the front door has to tell "nobody filmed this" apart from "the
 * backend did not answer in three seconds", and say the true one.
 *
 * Before this suite both read paths degraded to `[]`, so a 3 s deadline on a
 * cold cache rendered "No beta filmed yet." and "No similar climbs on this
 * layout." — factual claims about the climb, published to readers and to Google
 * on an indexed page, 6,922 + 748 times in the 14 days Sentry measured.
 *
 * Three assertions, one per state, because two of them are only meaningful next
 * to the third: an unavailable section must not borrow the empty section's copy,
 * an empty section must keep it, and a loaded section must render content.
 */

vi.mock('server-only', () => ({}));

vi.mock('@/app/lib/i18n/server', () => ({
  getServerTranslation: vi.fn(async () => ({
    t: (key: string) => key,
    locale: 'en-US',
  })),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en-US' } }),
}));

// Every band of the page except the two under test. They pull in client
// islands, posthog and the board renderer, none of which this file asserts.
vi.mock('../front-door-breadcrumb', () => ({ default: () => null }));
vi.mock('../climb-creative-work-json-ld', () => ({ default: () => null }));
vi.mock('../climb-facts', () => ({ default: () => null }));
vi.mock('../climb-handoff-cta', () => ({ default: () => null }));
vi.mock('../angle-cross-links', () => ({ default: () => null }));
vi.mock('@/app/components/climb-detail/climb-view-seo-fragment', () => ({ default: () => null }));
vi.mock('@/app/components/social/climb-social-section', () => ({ default: () => null }));

vi.mock('@/app/components/board-renderer/util', () => ({
  buildBoardArtLayers: vi.fn(() => ({ backgroundUrls: [], overlayUrl: null })),
  toDarkArtUrl: (url: string) => url,
}));

// Kept real below the fold — the similar-climbs half of the fix is exactly what
// this component does with (and without) a seed, so stubbing it out would leave
// the assertion checking a prop rather than the rendered section.
vi.mock('@/app/components/board-renderer/board-image-layers', () => ({ default: () => null }));
vi.mock('@/app/components/board-renderer/board-canvas-renderer', () => ({ default: () => null }));
vi.mock('@/app/lib/board-render-worker/worker-manager', () => ({ useCanvasRendererReady: () => false }));
vi.mock('@/app/hooks/use-is-dark-mode', () => ({ useIsDarkMode: () => false }));
vi.mock('@/app/hooks/use-grade-format', () => ({
  useGradeFormat: () => ({ formatGrade: (grade?: string) => grade, getGradeColor: () => undefined }),
}));
vi.mock('@/app/components/i18n/locale-link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));
vi.mock('@/app/lib/analytics', () => ({ track: vi.fn(), trackBeforeNavigation: vi.fn() }));
vi.mock('@/app/lib/graphql/client', () => ({
  createGraphQLHttpClient: () => ({
    request: () => {
      throw new Error('server render must not reach the network');
    },
  }),
}));

const ClimbFrontDoor = (await import('../climb-front-door')).default;

function makeClimb(): Climb {
  return {
    uuid: 'CLIMB-UNDER-TEST',
    name: 'Test Climb',
    difficulty: 'V5',
    setter_username: 'setter-person',
    quality_average: '4.20',
    ascensionist_count: 12,
    frames: 'p1r12',
    description: null,
  } as unknown as Climb;
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
    boardWidth: 1080,
    boardHeight: 1350,
  } as unknown as BoardDetails;
}

function makeBetaLink(): BetaLink {
  return { link: 'https://www.instagram.com/p/abc/', foreignUsername: 'filmer' } as unknown as BetaLink;
}

function makeSimilarClimb(): SimilarClimb {
  return {
    uuid: 'SIMILAR0',
    name: 'Similar Boulder',
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

async function renderFrontDoor(sections: {
  similarClimbs: FrontDoorSection<SimilarClimb>;
  betaLinks: FrontDoorSection<BetaLink>;
}): Promise<string> {
  const element = (
    <ClimbFrontDoor
      climb={makeClimb()}
      boardDetails={makeBoardDetails()}
      angle={40}
      canonicalAngle={40}
      angleStats={[]}
      similarClimbs={sections.similarClimbs}
      betaLinks={sections.betaLinks}
      handoffPath="/kilter/1/10/1,20/40/view/CLIMB-UNDER-TEST"
      tree="config-tuple"
    />
  );
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderToString(
    <QueryClientProvider client={queryClient}>{await resolveServerTree(element)}</QueryClientProvider>,
  );
}

describe('front-door sections whose backend read timed out', () => {
  it('says beta did not load instead of claiming nobody has filmed it', async () => {
    const html = await renderFrontDoor({
      similarClimbs: { status: 'loaded', items: [] },
      betaLinks: { status: 'unavailable' },
    });

    expect(html).toContain('frontDoor.beta.unavailable');
    expect(html).not.toContain('frontDoor.beta.empty');
  });

  it('says similar climbs did not load instead of claiming the layout has none', async () => {
    const html = await renderFrontDoor({
      similarClimbs: { status: 'unavailable' },
      betaLinks: { status: 'loaded', items: [] },
    });

    expect(html).toContain('frontDoor.similar.unavailable');
    expect(html).not.toContain('similarClimbs.emptyOnLayout');
    // Prose, not a spinner: this page is indexed, and a crawler reads the
    // loading state as the section's final content.
    expect(html).not.toContain('MuiCircularProgress');
  });

  it('still says the sections are empty when the backend actually answered', async () => {
    const html = await renderFrontDoor({
      similarClimbs: { status: 'loaded', items: [] },
      betaLinks: { status: 'loaded', items: [] },
    });

    expect(html).toContain('frontDoor.beta.empty');
    expect(html).toContain('similarClimbs.emptyOnLayout');
    expect(html).not.toContain('frontDoor.beta.unavailable');
    expect(html).not.toContain('frontDoor.similar.unavailable');
  });

  it('renders the content when the backend answered with rows', async () => {
    const html = await renderFrontDoor({
      similarClimbs: { status: 'loaded', items: [makeSimilarClimb()] },
      betaLinks: { status: 'loaded', items: [makeBetaLink()] },
    });

    expect(html).toContain('/view/similar-boulder-SIMILAR0');
    expect(html).not.toContain('frontDoor.beta.empty');
    expect(html).not.toContain('frontDoor.beta.unavailable');
    expect(html).not.toContain('frontDoor.similar.unavailable');
  });
});
