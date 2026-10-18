// @vitest-environment jsdom
// How many requests the Beta Videos line costs when Beta Videos is the
// collapsed peek, counted at the HTTP client. DeferredSections and the
// `useBetaLinks` hook are the real ones; only the settle gate is driven here.
//
//   three fast swipes             -> 0
//   a pause on one climb          -> 1, however often the drawer re-renders
import { createElement, type ReactNode } from 'react';
import { act, render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { GET_BETA_LINKS } from '@boardsesh/graphql/operations';
import type { Climb } from '@boardsesh/shared-schema';

vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  DynamicColorIOS: (appearances: { light: string }) => appearances.light,
  PlatformColor: (name: string) => name,
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  Pressable: ({ children }: { children?: ReactNode }) => createElement('button', null, children),
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { count?: number }) => (options?.count === undefined ? key : `${key}:${options.count}`),
  }),
}));
vi.mock('expo-haptics', () => ({ selectionAsync: vi.fn() }));
vi.mock('@boardsesh/board-react', () => ({ useLogbook: () => ({ logbook: [], isLoading: false }) }));
vi.mock('../../Icon', () => ({ Icon: () => null }));
vi.mock('../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));
vi.mock('../../PressableSurface', () => ({
  PressableSurface: ({ children }: { children?: ReactNode }) => createElement('button', null, children),
}));
vi.mock('../../CollapsibleSection', () => ({
  CollapsibleSection: ({ title, summary }: { title: string; summary?: string | null }) =>
    createElement('section', { 'data-title': title, 'data-summary': summary ?? undefined }),
}));
vi.mock('../LogbookSection', () => ({ LogbookSection: () => null }));
vi.mock('../ClimberLogsSection', () => ({ ClimberLogsSection: () => null }));
vi.mock('../BetaVideosSection', () => ({ BetaVideosSection: () => null }));
vi.mock('../CommunitySection', () => ({ CommunitySection: () => null }));
vi.mock('../SimilarClimbsSection', () => ({ SimilarClimbsSection: () => null }));
vi.mock('../BoardseshGradeSection', () => ({ BoardseshGradeSection: () => null }));
vi.mock('../SetterNotesSection', () => ({ SetterNotesSection: () => null }));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({ brandColors: { primary: '#primary' }, systemColors: {} }),
}));
vi.mock('../../../providers/feature-flags-provider', () => ({ useBoardseshGradeEnabled: () => false }));
vi.mock('../../../hooks/use-grade-format', () => ({
  useGradeFormat: () => ({ gradeFormat: 'v_grade', formatGradeByDifficultyId: () => null }),
}));
vi.mock('../../../providers/auth-provider', () => ({ useAuth: () => ({ isAuthenticated: true }) }));
vi.mock('../../../lib/graphql/hooks/use-followed-authors', () => ({
  useFollowedAuthorsSnapshot: () => ({ data: { users: [] }, isError: false }),
}));

// The collapsed peek, its saved state loaded.
vi.mock('../../../lib/section-expand-store', () => ({
  useSectionExpanded: () => ({ expanded: false, loaded: true }),
}));
const viewer = vi.hoisted(() => ({ settled: false }));
vi.mock('../../../hooks/use-climb-settled', () => ({ useClimbSettled: () => viewer.settled }));
vi.mock('../../../hooks/use-deferred-after-interactions', () => ({ useDeferredAfterInteractions: () => false }));
vi.mock('../../../hooks/use-is-offline', () => ({ useIsOffline: () => false }));

vi.mock('../../../lib/graphql/hooks/use-similar-climbs', () => ({ useSimilarClimbs: () => ({ data: undefined }) }));
vi.mock('../../../lib/graphql/hooks', async () => ({
  ...(await import('../../../lib/graphql/hooks/use-beta-links')),
  useBoardseshGrade: () => ({ data: undefined }),
  useClimbStatsHistory: () => ({ data: undefined }),
  useFollowingClimbLogs: () => ({ data: undefined }),
  useClimbLogsPreview: () => ({ data: undefined }),
}));

const server = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('../../../lib/graphql/client', () => ({ getHttpClient: () => ({ request: server.request }) }));

import { DeferredSections } from '../DeferredSections';

const ORDER = [
  'betaVideos',
  'logbook',
  'climberLogs',
  'setterNotes',
  'boardseshGrade',
  'community',
  'similarClimbs',
] as const;
const betaRequests = () => server.request.mock.calls.filter(([document]) => document === GET_BETA_LINKS).length;

function renderDrawer() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const element = (climbUuid: string) =>
    createElement(
      QueryClientProvider,
      { client },
      createElement(DeferredSections, {
        climb: { uuid: climbUuid, userAscents: 0, userAttempts: 0, difficulty: '6a/V3' } as Climb,
        boardName: 'kilter',
        layoutId: 1,
        sizeId: 10,
        setIds: '1,2',
        angle: 40,
        enabled: true,
        contentEnabled: false,
        order: ORDER,
        onSimilarClimbPress: () => {},
      }),
    );
  const view = render(element('climb-1'));
  return { ...view, client, show: (climbUuid: string) => view.rerender(element(climbUuid)) };
}

async function settleRequests(client: QueryClient) {
  let quietTurns = 0;
  while (quietTurns < 2) {
    const sentBefore = server.request.mock.calls.length;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    quietTurns = client.isFetching() === 0 && server.request.mock.calls.length === sentBefore ? quietTurns + 1 : 0;
  }
}

beforeEach(() => {
  viewer.settled = false;
  server.request.mockReset();
  server.request.mockImplementation(async (document: unknown) => {
    if (document === GET_BETA_LINKS) return { betaLinks: [] };
    throw new Error('unexpected document');
  });
});

describe('requests for the Beta Videos line when it is the collapsed peek', () => {
  it('sends nothing for three climbs only swiped past', async () => {
    const view = renderDrawer();
    view.show('climb-2');
    view.show('climb-3');
    await settleRequests(view.client);

    expect(betaRequests()).toBe(0);
  });

  it('sends one request once the climber pauses on a climb, however often the drawer re-renders', async () => {
    const view = renderDrawer();
    view.show('climb-2');
    view.show('climb-3');
    viewer.settled = true;
    view.show('climb-3');
    view.show('climb-3');
    await settleRequests(view.client);

    expect(betaRequests()).toBe(1);
    expect(server.request.mock.calls[0]?.[1]).toEqual({ boardType: 'kilter', climbUuid: 'climb-3' });
    expect(view.container.querySelector('[data-title="mobile.betaVideos.title"]')?.getAttribute('data-summary')).toBe(
      'mobile.betaVideos.collapsedEmpty',
    );
  });
});
