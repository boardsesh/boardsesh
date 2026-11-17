// @vitest-environment jsdom
import { createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { SHARED_EVENTS } from '@boardsesh/analytics';
import type { ActivityTick } from '../../../db/queries/get-activity-ticks-local';

const router = vi.hoisted(() => ({ push: vi.fn() }));
const drawer = vi.hoisted(() => ({ openPlayDrawer: vi.fn(), openClimb: vi.fn() }));
const analytics = vi.hoisted(() => ({ track: vi.fn() }));
const state = vi.hoisted(() => ({
  ticks: undefined as unknown[] | undefined,
  art: undefined as unknown[] | undefined,
  attempts: undefined as unknown[] | undefined,
  queriedKeys: [] as string[],
}));

vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  DynamicColorIOS: (appearances: { light: string }) => appearances.light,
  PlatformColor: (name: string) => name,
  View: ({ children, testID }: { children?: ReactNode; testID?: string }) =>
    createElement('div', { 'data-testid': testID }, children),
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      key === 'mobile.home.sections.projects.tries' && options ? `${String(options.count)} tries` : key,
    i18n: { language: 'en-US' },
  }),
}));
vi.mock('@tanstack/react-query', () => ({
  useQuery: ({ queryKey, enabled }: { queryKey: readonly unknown[]; enabled?: boolean }) => {
    if (enabled) state.queriedKeys.push(String(queryKey[0]));
    if (queryKey[0] === 'localClimbArt') return { data: enabled ? (state.art ?? []) : undefined };
    return { data: enabled ? state.attempts : undefined };
  },
}));
vi.mock('../../../lib/graphql/client', () => ({ getHttpClient: () => ({ request: vi.fn() }) }));
vi.mock('../../../lib/playlists/board-details-for-playlist', () => ({
  getBoardConfigForClimb: (_boardType: string, layoutId: number) => ({
    boardName: 'kilter',
    layoutId,
    sizeId: 10,
    setIds: [1, 20],
  }),
}));
vi.mock('../../../db', () => ({ getDatabaseHandle: () => null }));
vi.mock('../../../db/queries/get-climb-art-local', () => ({ readClimbArtLocal: vi.fn(async () => []) }));
vi.mock('../use-activity-ticks', () => ({ useActivityTicks: () => state.ticks }));
vi.mock('../../../hooks/use-current-user-id', () => ({
  useStoredUserId: () => ({ userId: 'user-1', isLoading: false }),
}));
vi.mock('../../../hooks/use-grade-format', () => ({
  useGradeFormat: () => ({ formatGradeByDifficultyId: (difficulty: number) => `V${difficulty - 16}` }),
}));
vi.mock('../../../lib/analytics', () => ({ track: analytics.track }));
vi.mock('../../../lib/haptics', () => ({ hapticLight: vi.fn() }));
vi.mock('../../../lib/open-climb-in-play-drawer', () => ({ openClimbInPlayDrawer: drawer.openClimb }));
vi.mock('../../../lib/routing/scoped-navigation', () => ({ useScopedRouter: () => router }));
vi.mock('../../../providers/drawer-host-provider', () => ({
  useDrawerHost: () => ({ openPlayDrawer: drawer.openPlayDrawer }),
}));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({ systemColors: {}, chartColors: {}, brandColors: {} }),
}));
vi.mock('../../Icon', () => ({ Icon: () => null }));
vi.mock('../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('p', null, children),
}));
vi.mock('../../ClimbListThumbnail', () => ({ ClimbListThumbnail: () => null }));
vi.mock('../../InsetGroupedList', () => ({
  InsetGroupedList: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  insetGroupedRowStyles: { row: {}, text: {} },
}));
vi.mock('../HomeSectionFrame', () => ({
  HomeSectionFrame: ({ title, testID, children }: { title: string; testID: string; children?: ReactNode }) =>
    createElement('section', { 'data-testid': testID, 'aria-label': title }, children),
}));
vi.mock('../../ArtRow', () => ({
  ArtRow: ({
    title,
    subtitle,
    onPress,
    testID,
  }: {
    title: string;
    subtitle?: string;
    onPress?: () => void;
    testID?: string;
  }) =>
    createElement(
      'button',
      { onClick: onPress, 'data-testid': testID },
      createElement('span', { 'data-testid': `${testID}-title` }, title),
      createElement('span', { 'data-testid': `${testID}-subtitle` }, subtitle),
    ),
}));
vi.mock('../../PressableSurface', () => ({
  PressableSurface: ({
    children,
    onPress,
    accessibilityLabel,
    testID,
  }: {
    children?: ReactNode;
    onPress: () => void;
    accessibilityLabel?: string;
    testID?: string;
  }) =>
    createElement('button', { onClick: onPress, 'aria-label': accessibilityLabel, 'data-testid': testID }, children),
}));

import { HomeProjectsSection } from '../HomeProjectsSection';

function tick(
  climbUuid: string,
  climbedAt: string,
  status: ActivityTick['status'],
  overrides: Partial<ActivityTick> = {},
): ActivityTick {
  return {
    climbedAt,
    status,
    difficulty: 22,
    boardType: 'kilter',
    climbUuid,
    angle: 40,
    climbName: `Name ${climbUuid}`,
    layoutId: 8,
    attemptCount: 1,
    ...overrides,
  } satisfies ActivityTick;
}

beforeEach(() => {
  state.ticks = undefined;
  state.art = undefined;
  state.attempts = undefined;
  state.queriedKeys = [];
  router.push.mockClear();
  drawer.openClimb.mockClear();
  analytics.track.mockClear();
});

afterEach(() => {
  cleanup();
});

describe('HomeProjectsSection', () => {
  it('draws nothing while the ticks are not read yet', () => {
    const { container } = render(createElement(HomeProjectsSection));
    expect(container.innerHTML).toBe('');
  });

  it('draws nothing when every climb was sent', () => {
    state.ticks = [tick('a', '2026-11-10T18:00:00Z', 'send'), tick('b', '2026-11-11T18:00:00Z', 'flash')];
    const { container } = render(createElement(HomeProjectsSection));
    expect(container.innerHTML).toBe('');
  });

  it('shows only unsent climbs, latest tried first, at most three', () => {
    state.ticks = [
      tick('old', '2026-11-01T18:00:00Z', 'attempt'),
      tick('sent', '2026-11-12T18:00:00Z', 'attempt'),
      tick('sent', '2026-11-13T18:00:00Z', 'send'),
      tick('mid', '2026-11-05T18:00:00Z', 'attempt'),
      tick('new', '2026-11-09T18:00:00Z', 'attempt'),
      tick('newest', '2026-11-10T18:00:00Z', 'attempt'),
    ];
    render(createElement(HomeProjectsSection));
    const rowIds = screen.getAllByTestId(/^home-project-[a-z]+$/).map((element) => element.getAttribute('data-testid'));
    expect(rowIds).toEqual(['home-project-newest', 'home-project-new', 'home-project-mid']);
    expect(screen.queryByTestId('home-project-sent')).toBeNull();
    expect(screen.queryByTestId('home-project-old')).toBeNull();
    expect(screen.getByTestId('home-projects-all')).toBeTruthy();
  });

  it('sums the tries across ticks and leads the subtitle with the grade', () => {
    state.ticks = [
      tick('a', '2026-11-01T18:00:00Z', 'attempt', { attemptCount: 2 }),
      tick('a', '2026-11-02T18:00:00Z', 'attempt', { attemptCount: 3 }),
    ];
    render(createElement(HomeProjectsSection));
    expect(screen.getByTestId('home-project-a-subtitle').textContent).toBe('V6 · 5 tries');
    expect(screen.getByTestId('home-project-a-title').textContent).toBe('Name a');
  });

  it('drops a climb once it is sent', () => {
    state.ticks = [tick('a', '2026-11-01T18:00:00Z', 'attempt')];
    render(createElement(HomeProjectsSection));
    expect(screen.getByTestId('home-project-a')).toBeTruthy();
    cleanup();
    state.ticks = [...state.ticks, tick('a', '2026-11-02T18:00:00Z', 'send')];
    render(createElement(HomeProjectsSection));
    expect(screen.queryByTestId('home-project-a')).toBeNull();
  });

  it('opens the climb at its latest angle and tracks the tap', () => {
    state.ticks = [
      tick('a', '2026-11-01T18:00:00Z', 'attempt', { angle: 35 }),
      tick('a', '2026-11-03T18:00:00Z', 'attempt', { angle: 45 }),
    ];
    state.art = [{ boardType: 'kilter', climbUuid: 'a', frames: 'p1r12', layoutId: 8, compatibleSizeIds: [10] }];
    render(createElement(HomeProjectsSection));
    fireEvent.click(screen.getByTestId('home-project-a'));
    expect(drawer.openClimb).toHaveBeenCalledExactlyOnceWith(
      { kind: 'ref', climbUuid: 'a', boardType: 'kilter', layoutId: 8, angle: 45, sizeId: 10, setIds: '1,20' },
      { openPlayDrawer: drawer.openPlayDrawer, router },
    );
    expect(analytics.track).toHaveBeenCalledExactlyOnceWith(SHARED_EVENTS.HomeSectionTapped, {
      section: 'projects',
      target: 'climb',
    });
  });

  it("names, draws and opens a climb whose board is not downloaded from the server's latest attempts", () => {
    state.ticks = [tick('a', '2026-11-01T18:00:00Z', 'attempt', { climbName: null })];
    state.attempts = [
      {
        climbUuid: 'a',
        boardType: 'kilter',
        climbName: 'Jolly Roger',
        layoutId: 1,
        frames: 'p1r12',
        renderBoard: { layoutId: 1, sizeId: 7, setIds: [1, 20] },
      },
    ];
    render(createElement(HomeProjectsSection));
    expect(state.queriedKeys).toContain('homeProjectAttempts');
    expect(screen.getByTestId('home-project-a-title').textContent).toBe('Jolly Roger');
    fireEvent.click(screen.getByTestId('home-project-a'));
    expect(drawer.openClimb).toHaveBeenCalledWith(
      expect.objectContaining({ climbUuid: 'a', layoutId: 1, sizeId: 7, setIds: '1,20' }),
      { openPlayDrawer: drawer.openPlayDrawer, router },
    );
  });

  it('does not ask the server when the phone knows every row', () => {
    state.ticks = [tick('a', '2026-11-01T18:00:00Z', 'attempt')];
    state.art = [{ boardType: 'kilter', climbUuid: 'a', frames: 'p1r12', layoutId: 8, compatibleSizeIds: [10] }];
    render(createElement(HomeProjectsSection));
    expect(state.queriedKeys).not.toContain('homeProjectAttempts');
  });

  it('does not open a climb whose board neither the phone nor the server knows', () => {
    state.ticks = [tick('a', '2026-11-01T18:00:00Z', 'attempt')];
    render(createElement(HomeProjectsSection));
    fireEvent.click(screen.getByTestId('home-project-a'));
    expect(drawer.openClimb).not.toHaveBeenCalled();
    expect(analytics.track).not.toHaveBeenCalled();
  });

  it('opens the Projects playlist from See all, with its anchor, and tracks the tap', () => {
    state.ticks = [tick('a', '2026-11-01T18:00:00Z', 'attempt')];
    render(createElement(HomeProjectsSection));
    fireEvent.click(screen.getByTestId('home-projects-all'));
    expect(router.push).toHaveBeenCalledExactlyOnceWith(
      { pathname: '/(tabs)/discover/smart/[type]', params: { type: 'PROJECTS', source: 'home' } },
      { withAnchor: true },
    );
    expect(analytics.track).toHaveBeenCalledExactlyOnceWith(SHARED_EVENTS.HomeSectionTapped, {
      section: 'projects',
      target: 'all',
    });
  });

  it('falls back to the unknown-climb key when the name is not on the phone', () => {
    state.ticks = [tick('a', '2026-11-01T18:00:00Z', 'attempt', { climbName: null })];
    render(createElement(HomeProjectsSection));
    expect(screen.getByTestId('home-project-a-title').textContent).toBe('mobile.home.sections.projects.unknownClimb');
  });
});
