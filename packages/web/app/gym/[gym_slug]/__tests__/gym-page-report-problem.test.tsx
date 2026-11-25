import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import React from 'react';
import type { Gym } from '@boardsesh/shared-schema';

/**
 * Report a problem on the public gym page (docs/product/directory-reports.md):
 * a flag on every board row and a "Report a problem" button for the gym, only
 * while the `directory-reports` flag is on and only for viewers who can't edit
 * the gym. With the flag off the page keeps Report a duplicate.
 */

vi.mock('server-only', () => ({}));
vi.mock('@/app/lib/server-board-discovery', () => ({ getBoardDiscovery: vi.fn(async () => []) }));
vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('notFound');
  },
  permanentRedirect: () => {
    throw new Error('permanentRedirect');
  },
}));
vi.mock('@/app/lib/i18n/server', () => ({
  getServerTranslation: vi.fn(async () => ({ t: (key: string) => key, locale: 'en-US' })),
}));
vi.mock('@/app/lib/i18n/get-locale', () => ({ getLocale: vi.fn(async () => 'en-US') }));
vi.mock('@/app/lib/auth/server-auth', () => ({ getServerAuthToken: vi.fn(async () => undefined) }));
vi.mock('@/app/lib/analytics', () => ({ track: vi.fn() }));

const reportsEnabled = vi.hoisted(() => ({ current: true }));
vi.mock('@/app/lib/directory-reports/directory-reports-flag', () => ({
  isDirectoryReportsEnabled: vi.fn(async () => reportsEnabled.current),
}));
const setupSuggestionsEnabled = vi.hoisted(() => ({ current: false }));
vi.mock('@/app/lib/directory-reports/directory-setup-suggestions-flag', () => ({
  isDirectorySetupSuggestionsEnabled: vi.fn(async () => setupSuggestionsEnabled.current),
}));

const executeAuthenticatedGraphQL = vi.hoisted(() => vi.fn());
vi.mock('@/app/lib/graphql/server-graphql', () => ({ executeAuthenticatedGraphQL }));

const GymPage = (await import('@/app/(site)/gym/[gym_slug]/page')).default;
const { ReportBoardButton, ReportGymButton, GymReportProblemHost } = await import('../gym-report-problem');
const GymReportDuplicateCta = (await import('../gym-report-duplicate-cta')).default;

const BOARDS = [
  {
    uuid: 'board-a',
    slug: 'crux-kilter',
    name: 'Crux - Kilter',
    boardType: 'kilter',
    layoutId: 1,
    sizeId: 10,
    setIds: '1,20',
    angle: 40,
    isAngleAdjustable: true,
    ownerId: 'sam',
  },
  {
    uuid: 'board-b',
    slug: 'crux-tension',
    name: 'Crux Tension',
    boardType: 'tension',
    layoutId: 9,
    sizeId: 1,
    setIds: '8',
    angle: 30,
    isAngleAdjustable: false,
    ownerId: null,
  },
];

function gym(slug: string, overrides: Partial<Gym> = {}): Gym {
  return {
    uuid: `uuid-${slug}`,
    slug,
    name: 'Crux',
    isPublic: true,
    canEdit: false,
    canClaim: false,
    isClaimed: true,
    listingState: 'RUN_BY_GYM',
    ...overrides,
  } as unknown as Gym;
}

function respondWith(gymRow: Gym): void {
  executeAuthenticatedGraphQL.mockImplementation(async (document: unknown) => {
    const text = String(document);
    if (text.includes('gymSprayWalls')) return { gymSprayWalls: [] };
    if (text.includes('gymBoards')) return { gymBoards: BOARDS };
    if (text.includes('gymBySlug')) return { gymBySlug: gymRow };
    return {};
  });
}

function allElements(node: React.ReactNode): React.ReactElement[] {
  const found: React.ReactElement[] = [];
  const visit = (current: React.ReactNode): void => {
    if (Array.isArray(current)) {
      for (const child of current) visit(child);
      return;
    }
    if (!React.isValidElement(current)) return;
    found.push(current);
    visit((current.props as { children?: React.ReactNode }).children);
  };
  visit(node);
  return found;
}

const elementsOfType = (tree: React.ReactNode, type: unknown) =>
  allElements(tree).filter((element) => element.type === type);

const renderPage = (slug: string) =>
  GymPage({ params: Promise.resolve({ gym_slug: slug }), searchParams: Promise.resolve({}) });

beforeEach(() => {
  executeAuthenticatedGraphQL.mockReset();
  reportsEnabled.current = true;
  setupSuggestionsEnabled.current = false;
});

describe('Report a problem on the gym page', () => {
  it('puts a flag on every board row and the gym button in place of Report a duplicate', async () => {
    respondWith(gym('report-on'));
    const tree = await renderPage('report-on');

    const flags = elementsOfType(tree, ReportBoardButton);
    expect(flags.map((flag) => (flag.props as { boardUuid: string }).boardUuid)).toEqual(['board-a', 'board-b']);
    // The row's name, with the gym's own name taken off the front.
    expect((flags[0].props as { boardName: string }).boardName).toBe('Kilter');
    expect(elementsOfType(tree, ReportGymButton)).toHaveLength(1);
    expect(elementsOfType(tree, GymReportDuplicateCta)).toHaveLength(0);
  });

  it('hands the dialog the boards it can report and the gym, with no creator names', async () => {
    respondWith(gym('report-island', { listingState: 'UNCLAIMED', canClaim: true, isClaimed: false }));
    const tree = await renderPage('report-island');
    const hosts = elementsOfType(tree, GymReportProblemHost);
    expect(hosts).toHaveLength(1);
    const props = hosts[0].props as React.ComponentProps<typeof GymReportProblemHost>;
    expect(props.gym).toMatchObject({ uuid: 'uuid-report-island', listingState: 'UNCLAIMED', slug: 'report-island' });
    expect(props.boards.map((board) => [board.uuid, board.ownerId])).toEqual([
      ['board-a', 'sam'],
      ['board-b', null],
    ]);
    expect(JSON.stringify(props)).not.toContain('ownerDisplayName');
    // Every flag and the gym button name the gym whose dialog they open.
    for (const button of [...elementsOfType(tree, ReportBoardButton), ...elementsOfType(tree, ReportGymButton)]) {
      expect((button.props as { gymUuid: string }).gymUuid).toBe('uuid-report-island');
    }
  });

  it("hands the dialog each board's setup, and the setup-suggestions flag as the page read it", async () => {
    respondWith(gym('report-setup', { listingState: 'UNCLAIMED', isClaimed: false }));
    let props = elementsOfType(await renderPage('report-setup'), GymReportProblemHost)[0].props as React.ComponentProps<
      typeof GymReportProblemHost
    >;
    expect(props.setupSuggestionsEnabled).toBe(false);
    expect(props.boards.map((board) => board.setup)).toEqual([
      { boardType: 'kilter', layoutId: 1, sizeId: 10, setIds: '1,20', angle: 40, isAngleAdjustable: true },
      { boardType: 'tension', layoutId: 9, sizeId: 1, setIds: '8', angle: 30, isAngleAdjustable: false },
    ]);

    setupSuggestionsEnabled.current = true;
    props = elementsOfType(await renderPage('report-setup'), GymReportProblemHost)[0].props as React.ComponentProps<
      typeof GymReportProblemHost
    >;
    expect(props.setupSuggestionsEnabled).toBe(true);
    expect(props.storeLabels).toMatchObject({ locale: 'en-US' });
  });

  it('shows staff nothing to report: they fix things from Manage gym', async () => {
    respondWith(gym('report-staff', { canEdit: true }));
    const tree = await renderPage('report-staff');

    expect(elementsOfType(tree, ReportBoardButton)).toHaveLength(0);
    expect(elementsOfType(tree, ReportGymButton)).toHaveLength(0);
    expect(elementsOfType(tree, GymReportProblemHost)).toHaveLength(0);
    expect(elementsOfType(tree, GymReportDuplicateCta)).toHaveLength(0);
  });

  it('keeps Report a duplicate and no flags while the flag is off', async () => {
    reportsEnabled.current = false;
    respondWith(gym('report-off'));
    const tree = await renderPage('report-off');

    expect(elementsOfType(tree, ReportBoardButton)).toHaveLength(0);
    expect(elementsOfType(tree, ReportGymButton)).toHaveLength(0);
    expect(elementsOfType(tree, GymReportDuplicateCta)).toHaveLength(1);
  });
});
