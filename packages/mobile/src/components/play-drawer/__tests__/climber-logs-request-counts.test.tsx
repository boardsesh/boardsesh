// @vitest-environment jsdom
// How many requests one settled climb costs for the Climber logs card, counted
// at the HTTP client. The database behind these is the scarce thing, so the
// numbers are pinned per kind of viewer:
//
//   follows nobody                         -> 1 everyone
//   follows people who logged the climb    -> 1 following
//   follows people who did not             -> 1 following, then 1 everyone
//
// DeferredSections, the card and both query hooks are the real ones: the count
// has to hold with the request asked from DeferredSections before the first
// scroll AND from the card once it mounts.
import { createElement, type ReactNode } from 'react';
import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { GET_CLIMB_LOGS, GET_FOLLOWING_CLIMB_ASCENTS } from '@boardsesh/graphql/operations';
import type { Climb } from '@boardsesh/shared-schema';

vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  DynamicColorIOS: (appearances: { light: string }) => appearances.light,
  PlatformColor: (name: string) => name,
  View: ({ children, testID }: { children?: ReactNode; testID?: string }) =>
    createElement('div', { 'data-testid': testID }, children),
  Pressable: ({ children }: { children?: ReactNode }) => createElement('button', null, children),
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('expo-haptics', () => ({ selectionAsync: vi.fn() }));
vi.mock('@boardsesh/board-react', () => ({ useLogbook: () => ({ logbook: [], isLoading: false }) }));
vi.mock('../../Icon', () => ({ Icon: () => null }));
vi.mock('../../Avatar', () => ({ Avatar: () => null }));
vi.mock('../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));
vi.mock('../../Button', () => ({ Button: ({ title }: { title: string }) => createElement('button', null, title) }));
vi.mock('../../PressableSurface', () => ({
  PressableSurface: ({ children }: { children?: ReactNode }) => createElement('button', null, children),
}));
vi.mock('../../CollapsibleSection', () => ({
  CollapsibleSection: ({ children }: { children?: ReactNode }) => createElement('section', null, children),
}));
vi.mock('../ClimberLogRow', () => ({
  ClimberLogRow: ({ group }: { group: { userId: string } }) =>
    createElement('div', { 'data-testid': 'climber-row' }, group.userId),
}));
vi.mock('../LogbookSection', () => ({ LogbookSection: () => null }));
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

// What the drawer knows about the viewer and the climb.
const viewer = vi.hoisted(() => ({
  signedIn: true,
  userId: 'viewer' as string | undefined,
  // `undefined` is a snapshot that has not loaded; `failed` one that never will.
  follows: [] as string[] | undefined,
  followsFailed: false,
  settled: true,
  scrolled: false,
  offline: false,
}));
vi.mock('../../../providers/auth-provider', () => ({ useAuth: () => ({ isAuthenticated: viewer.signedIn }) }));
vi.mock('../../../hooks/use-current-user-id', () => ({
  useStoredUserId: () => ({ userId: viewer.userId, isLoading: false }),
}));
vi.mock('../../../lib/graphql/hooks/use-followed-authors', () => ({
  useFollowedAuthorsSnapshot: () => ({
    data: viewer.follows ? { users: viewer.follows.map((userId) => ({ userId })) } : undefined,
    isError: viewer.followsFailed,
  }),
}));
vi.mock('../../../hooks/use-climb-settled', () => ({ useClimbSettled: () => viewer.settled }));
vi.mock('../../../hooks/use-deferred-after-interactions', () => ({
  useDeferredAfterInteractions: () => viewer.scrolled,
}));
vi.mock('../../../hooks/use-is-offline', () => ({ useIsOffline: () => viewer.offline }));
vi.mock('../../../lib/connectivity/use-connectivity', () => ({
  useConnectivity: () => ({ effectiveOffline: viewer.offline, reason: viewer.offline ? 'device_offline' : null }),
}));

// The two real query hooks, behind the barrel DeferredSections imports from.
vi.mock('../../../lib/graphql/hooks', async () => ({
  useBoardseshGrade: () => ({ data: undefined }),
  useClimbStatsHistory: () => ({ data: undefined }),
  ...(await import('../../../lib/graphql/hooks/use-following-climb-logs')),
  ...(await import('../../../lib/graphql/hooks/use-climb-logs')),
}));

const server = vi.hoisted(() => ({
  request: vi.fn(),
  // How many followed climbers logged the climb, or an error to answer with.
  followedClimbers: 0 as number | Error,
}));
vi.mock('../../../lib/graphql/client', () => ({ getHttpClient: () => ({ request: server.request }) }));

import { DeferredSections } from '../DeferredSections';

function logBy(userId: string) {
  return {
    uuid: `log-${userId}`,
    userId,
    userDisplayName: userId,
    userAvatarUrl: null,
    climbUuid: 'climb-1',
    angle: 40,
    isMirror: false,
    status: 'send',
    attemptCount: 2,
    quality: null,
    effectiveQuality: null,
    difficulty: null,
    comment: 'beta',
    climbedAt: '2026-03-10T18:00:00',
  };
}

const requestsFor = (document: unknown) => server.request.mock.calls.filter(([sent]) => sent === document).length;
const requestCounts = () => ({
  following: requestsFor(GET_FOLLOWING_CLIMB_ASCENTS),
  everyone: requestsFor(GET_CLIMB_LOGS),
});

const climb = { uuid: 'climb-1', userAscents: 0, userAttempts: 0, difficulty: '6a/V3' } as Climb;

function renderDrawer() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const element = () =>
    createElement(
      QueryClientProvider,
      { client },
      // A fresh element each time: DeferredSections is memoised, and the
      // drawer's state lives in the mocked hooks above.
      createElement(DeferredSections, {
        climb: { ...climb },
        boardName: 'kilter',
        layoutId: 1,
        sizeId: 10,
        setIds: '1,2',
        angle: 40,
        enabled: true,
        contentEnabled: true,
        onSimilarClimbPress: () => {},
      }),
    );
  const view = render(element());
  return { ...view, client, update: () => view.rerender(element()) };
}

/**
 * Lets every request that is going to be sent go out and land: waits until
 * nothing is in flight and two turns in a row sent nothing new. Not a fixed
 * delay, so a slow machine cannot cut a request chain short.
 */
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

/** Opens on the climb, waits, then scrolls so the card mounts and asks for itself too. */
async function openThenScroll() {
  viewer.scrolled = false;
  const view = renderDrawer();
  await settleRequests(view.client);
  const beforeScroll = requestCounts();
  viewer.scrolled = true;
  view.update();
  await settleRequests(view.client);
  return { view, beforeScroll, afterScroll: requestCounts() };
}

beforeEach(() => {
  viewer.signedIn = true;
  viewer.userId = 'viewer';
  viewer.follows = [];
  viewer.followsFailed = false;
  viewer.settled = true;
  viewer.scrolled = false;
  viewer.offline = false;
  server.followedClimbers = 0;
  server.request.mockReset();
  server.request.mockImplementation(async (document: unknown) => {
    if (document === GET_FOLLOWING_CLIMB_ASCENTS) {
      if (server.followedClimbers instanceof Error) throw server.followedClimbers;
      const items = Array.from({ length: server.followedClimbers }, (_, index) => logBy(`friend-${index}`));
      return {
        followingClimbAscents: {
          items,
          hasMore: false,
          summary: { climberCount: items.length, senderCount: items.length, byAngle: [] },
        },
      };
    }
    if (document === GET_CLIMB_LOGS) {
      return { climbLogs: { items: [logBy('stranger')], cursor: null, hasMore: false } };
    }
    throw new Error('unexpected document');
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('requests per settled climb for the Climber logs card', () => {
  it('follows nobody: one request for everyone, sent before the first scroll', async () => {
    viewer.follows = [];
    const { view, beforeScroll, afterScroll } = await openThenScroll();

    expect(beforeScroll).toEqual({ following: 0, everyone: 1 });
    expect(afterScroll).toEqual({ following: 0, everyone: 1 });
    expect(view.getByTestId('climber-row').textContent).toBe('stranger');
  });

  it('follows people who logged the climb: one request for them, none for everyone', async () => {
    viewer.follows = ['friend-0'];
    server.followedClimbers = 1;
    const { view, beforeScroll, afterScroll } = await openThenScroll();

    expect(beforeScroll).toEqual({ following: 1, everyone: 0 });
    expect(afterScroll).toEqual({ following: 1, everyone: 0 });
    expect(view.getByTestId('climber-row').textContent).toBe('friend-0');
  });

  it('follows people who did not log it: one for them, then one for everyone, both before the first scroll', async () => {
    viewer.follows = ['friend-0'];
    server.followedClimbers = 0;
    const { view, beforeScroll, afterScroll } = await openThenScroll();

    expect(beforeScroll).toEqual({ following: 1, everyone: 1 });
    expect(afterScroll).toEqual({ following: 1, everyone: 1 });
    // In that order: the second is only sent on the first one's answer.
    expect(server.request.mock.calls.map(([document]) => document)).toEqual([
      GET_FOLLOWING_CLIMB_ASCENTS,
      GET_CLIMB_LOGS,
    ]);
    expect(view.getByTestId('climber-row').textContent).toBe('stranger');
  });

  it('follows people, and their request failed: nothing for everyone', async () => {
    viewer.follows = ['friend-0'];
    server.followedClimbers = new Error('Internal server error');
    const { beforeScroll, afterScroll } = await openThenScroll();

    expect(beforeScroll).toEqual({ following: 1, everyone: 0 });
    // The card retries the failed request once when it mounts, as it always has.
    expect(afterScroll).toEqual({ following: 2, everyone: 0 });
  });

  it.each([
    ['nobody followed logged it', 0, { following: 1, everyone: 1 }],
    ['somebody followed logged it', 2, { following: 1, everyone: 0 }],
  ])('no follow snapshot to go on, and %s', async (_label, followedClimbers, expected) => {
    viewer.follows = undefined;
    viewer.followsFailed = true;
    server.followedClimbers = followedClimbers;
    const { afterScroll } = await openThenScroll();

    expect(afterScroll).toEqual(expected);
  });

  it.each([
    ['the follow snapshot is still loading', () => (viewer.follows = undefined)],
    ['the climb is only swiped past', () => (viewer.settled = false)],
    ['nobody is signed in', () => ((viewer.signedIn = false), (viewer.userId = undefined))],
    ['a store capture is running', () => vi.stubEnv('EXPO_PUBLIC_SCREENSHOT_MODE', '1')],
  ])('sends nothing at all when %s', async (_label, arrange) => {
    viewer.follows = ['friend-0'];
    arrange();
    const { afterScroll } = await openThenScroll();

    expect(afterScroll).toEqual({ following: 0, everyone: 0 });
  });

  it.each([
    ['follows nobody', [] as string[]],
    ['follows people', ['friend-0']],
  ])('sends nothing for everyone with no signal (%s)', async (_label, follows) => {
    viewer.follows = follows;
    viewer.offline = true;
    const { afterScroll } = await openThenScroll();

    expect(afterScroll.everyone).toBe(0);
  });

  it('asks once per climb however often the drawer re-renders', async () => {
    viewer.follows = [];
    const { view } = await openThenScroll();
    view.update();
    view.update();
    await settleRequests(view.client);

    expect(requestCounts()).toEqual({ following: 0, everyone: 1 });
  });
});
