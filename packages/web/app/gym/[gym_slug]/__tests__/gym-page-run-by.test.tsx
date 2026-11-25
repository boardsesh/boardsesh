import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import React from 'react';
import type { Gym } from '@boardsesh/shared-schema';

/**
 * Who runs the gym, under its H1 (docs/product/gym-board-governance.md, decision
 * 4), and the claim call-out's two places: above the boards for a phone, in the
 * details column from 960px.
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
const session = vi.hoisted(() => ({ token: undefined as string | undefined }));
vi.mock('@/app/lib/auth/server-auth', () => ({ getServerAuthToken: vi.fn(async () => session.token) }));
vi.mock('@/app/lib/analytics', () => ({ track: vi.fn() }));
vi.mock('@/app/lib/directory-reports/directory-reports-flag', () => ({
  isDirectoryReportsEnabled: vi.fn(async () => true),
}));

const executeAuthenticatedGraphQL = vi.hoisted(() => vi.fn());
vi.mock('@/app/lib/graphql/server-graphql', () => ({ executeAuthenticatedGraphQL }));

const GymPage = (await import('@/app/(site)/gym/[gym_slug]/page')).default;
const GymRunByLine = (await import('../gym-run-by-line')).default;
const GymClaimCta = (await import('../gym-claim-cta')).default;
const GymClaimCalloutMirror = (await import('../gym-claim-callout')).default;
const { PageShell } = await import('@/app/components/ui/page-shell');

function gym(overrides: Partial<Gym> = {}): Gym {
  return {
    uuid: 'uuid-crux',
    slug: 'crux',
    name: 'Crux',
    isPublic: true,
    canEdit: false,
    canClaim: false,
    isClaimed: false,
    listingState: 'UNCLAIMED',
    ...overrides,
  } as unknown as Gym;
}

function respondWith(gymRow: Gym, myPendingClaim: unknown = null): void {
  executeAuthenticatedGraphQL.mockImplementation(async (document: unknown) => {
    const text = String(document);
    if (text.includes('gymSprayWalls')) return { gymSprayWalls: [] };
    if (text.includes('gymBoards')) return { gymBoards: [] };
    if (text.includes('myPendingClaim')) return { gymBySlug: { uuid: gymRow.uuid, myPendingClaim } };
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
    const props = current.props as { children?: React.ReactNode; headerActions?: React.ReactNode };
    visit(props.headerActions);
    visit(props.children);
  };
  visit(node);
  return found;
}

const elementsOfType = (tree: React.ReactNode, type: unknown) =>
  allElements(tree).filter((element) => element.type === type);

const renderPage = () => GymPage({ params: Promise.resolve({ gym_slug: 'crux' }), searchParams: Promise.resolve({}) });

async function runByLine(): Promise<React.ComponentProps<typeof GymRunByLine>> {
  const tree = await renderPage();
  const [shell] = elementsOfType(tree, PageShell);
  const [line] = elementsOfType((shell.props as { headerActions: React.ReactNode }).headerActions, GymRunByLine);
  return line.props as React.ComponentProps<typeof GymRunByLine>;
}

beforeEach(() => {
  executeAuthenticatedGraphQL.mockReset();
  session.token = undefined;
});

describe('the run-by line under the H1', () => {
  it.each([
    ['RUN_BY_GYM', 'runBy.pillRunByGym'],
    ['CLIMBER_LISTED', 'runBy.pillClimberListed'],
    ['UNCLAIMED', 'runBy.pillUnclaimed'],
  ] as const)('says who runs a %s gym', async (listingState, label) => {
    respondWith(gym({ listingState, isClaimed: listingState !== 'UNCLAIMED' }));
    expect(await runByLine()).toMatchObject({ listingState, label });
  });

  it('offers "Run this gym? Claim it" to a signed-out visitor on a gym a climber added', async () => {
    respondWith(gym({ listingState: 'CLIMBER_LISTED', isClaimed: true }));
    expect((await runByLine()).claim).toEqual({ gymUuid: 'uuid-crux', label: 'runBy.claimInline' });
  });

  it('offers no claim on a gym its staff run, even to a signed-in viewer the server lets claim', async () => {
    session.token = 'token';
    respondWith(gym({ listingState: 'RUN_BY_GYM', isClaimed: true, canClaim: true }));
    expect((await runByLine()).claim).toBeNull();
  });

  it('offers none to a claimant already in the queue', async () => {
    session.token = 'token';
    respondWith(gym({ canClaim: true }), { id: '1', method: 'admin', createdAt: '2026-11-20T10:00:00.000Z' });
    expect((await runByLine()).claim).toBeNull();
  });
});

describe('the claim call-out', () => {
  it('renders in both places, each with the class that shows it at its width', async () => {
    respondWith(gym());
    const tree = await renderPage();
    const [mirror] = elementsOfType(tree, GymClaimCalloutMirror);
    const [host] = elementsOfType(tree, GymClaimCta);
    expect((mirror.props as { className?: string }).className).toBeTruthy();
    expect((host.props as { className?: string }).className).toBeTruthy();
    expect((mirror.props as { className?: string }).className).not.toBe(
      (host.props as { className?: string }).className,
    );
  });

  it('renders in neither place on a gym its staff run', async () => {
    respondWith(gym({ listingState: 'RUN_BY_GYM', isClaimed: true }));
    const tree = await renderPage();
    expect(elementsOfType(tree, GymClaimCalloutMirror)).toHaveLength(0);
    expect(elementsOfType(tree, GymClaimCta)).toHaveLength(0);
  });
});
