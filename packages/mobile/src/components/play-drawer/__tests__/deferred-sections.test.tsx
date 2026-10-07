// @vitest-environment jsdom
import { createElement, type ReactNode } from 'react';
import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Climb } from '@boardsesh/shared-schema';

const deferred = vi.hoisted(() => ({
  ready: false,
  calls: [] as Array<{ active: boolean; resetKey: string | number | undefined }>,
}));

const flags = vi.hoisted(() => ({ boardseshGrade: false }));

const boardseshGradeQuery = vi.hoisted(() => ({
  calls: [] as Array<{ boardName: string; climbUuid: string | null; angle: number; enabled: boolean | undefined }>,
  data: undefined as unknown,
}));

// The followed-climbers logs read: its gate (open animation settled + dwell),
// what it was asked with, and what it answers.
const crewQuery = vi.hoisted(() => ({
  settled: false,
  gateCalls: [] as Array<{ active: boolean; climbUuid: string }>,
  calls: [] as Array<{ boardName: string; climbUuid: string | null; enabled: boolean | undefined }>,
  data: undefined as unknown,
}));

// Everyone else's newest logs, for the Climber logs card's fall-through rows:
// what it was asked with, and whether the phone has signal.
const everyoneQuery = vi.hoisted(() => ({
  calls: [] as Array<{ boardName: string; climbUuid: string | null; enabled: boolean }>,
  offline: false,
}));

// The phone's own snapshot of who the viewer follows.
const followedAuthors = vi.hoisted(() => ({
  result: { data: undefined, isError: false } as {
    data: { users: Array<{ userId: string }> } | undefined;
    isError: boolean;
  },
  calls: [] as Array<{ loadWhenMissing: boolean }>,
}));

vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  PlatformColor: (name: string) => name,
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  Pressable: ({ children }: { children?: ReactNode }) => createElement('button', null, children),
  StyleSheet: { create: (styles: unknown) => styles },
}));

// Keys by default. A test that reads a whole sentence sets `i18n.locale`, and
// `t` then fills the real catalog string for that locale.
const i18n = vi.hoisted(() => ({ locale: null as 'en-US' | 'de' | null }));
vi.mock('react-i18next', async () => {
  const catalogs: Record<'en-US' | 'de', unknown> = {
    'en-US': (await import('../../../../../shared/i18n/locales/en-US/session.json')).default,
    de: (await import('../../../../../shared/i18n/locales/de/session.json')).default,
  };
  const lookup = (catalog: unknown, key: string): string | undefined => {
    let node = catalog;
    for (const part of key.split('.')) {
      if (typeof node !== 'object' || node === null) return undefined;
      node = (node as Record<string, unknown>)[part];
    }
    return typeof node === 'string' ? node : undefined;
  };
  const t = (key: string, opts?: Record<string, unknown>) => {
    if (!i18n.locale) return key;
    const catalog = catalogs[i18n.locale];
    const plural = typeof opts?.count === 'number' ? `${key}_${opts.count === 1 ? 'one' : 'other'}` : key;
    const template = lookup(catalog, plural) ?? lookup(catalog, key) ?? key;
    return template.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => {
      const value = opts?.[name];
      return typeof value === 'string' || typeof value === 'number' ? `${value}` : '';
    });
  };
  return { useTranslation: () => ({ t }) };
});
vi.mock('expo-haptics', () => ({ selectionAsync: vi.fn() }));
const logbook = vi.hoisted(() => ({ entries: [] as unknown[] }));
vi.mock('@boardsesh/board-react', () => ({ useLogbook: () => ({ logbook: logbook.entries, isLoading: false }) }));
vi.mock('../../Icon', () => ({ Icon: () => null }));
const auth = vi.hoisted(() => ({ isAuthenticated: false }));
vi.mock('../../../providers/auth-provider', () => ({ useAuth: () => ({ isAuthenticated: auth.isAuthenticated }) }));
vi.mock('../../../providers/theme-provider', () => ({ useTheme: () => ({ brandColors: { primary: '#000' } }) }));

vi.mock('../../../hooks/use-deferred-after-interactions', () => ({
  useDeferredAfterInteractions: (active: boolean, resetKey?: string | number) => {
    deferred.calls.push({ active, resetKey });
    return deferred.ready;
  },
}));

vi.mock('../../CollapsibleSection', () => ({
  CollapsibleSection: ({
    title,
    summary,
    children,
    onHeaderLayout,
  }: {
    title: string;
    summary?: string | null;
    children?: ReactNode;
    onHeaderLayout?: (height: number) => void;
  }) => {
    onHeaderLayout?.(44);
    return createElement('section', { 'data-title': title, 'data-summary': summary ?? undefined }, children);
  },
}));

// SetterNotesSection renders through the real component (its suppression rules
// are what these tests assert), so only the leaf Text needs a DOM stand-in.
vi.mock('../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('p', { 'data-testid': 'text' }, children),
}));

vi.mock('../BetaVideosSection', () => ({
  BetaVideosSection: () => createElement('div', { 'data-testid': 'beta-videos' }),
}));

const logbookSection = vi.hoisted(() => ({ props: null as Record<string, unknown> | null }));
vi.mock('../LogbookSection', () => ({
  LogbookSection: (props: Record<string, unknown>) => {
    logbookSection.props = props;
    return createElement('div', { 'data-testid': 'logbook' });
  },
}));

const climberLogsSection = vi.hoisted(() => ({ props: null as Record<string, unknown> | null }));
vi.mock('../ClimberLogsSection', () => ({
  ClimberLogsSection: (props: Record<string, unknown>) => {
    climberLogsSection.props = props;
    return createElement('div', { 'data-testid': 'climber-logs' });
  },
}));

vi.mock('../CommunitySection', () => ({
  CommunitySection: () => createElement('div', { 'data-testid': 'community' }),
}));

vi.mock('../SimilarClimbsSection', () => ({
  SimilarClimbsSection: () => createElement('div', { 'data-testid': 'similar-climbs' }),
}));

vi.mock('../BoardseshGradeSection', () => ({
  BoardseshGradeSection: () => createElement('div', { 'data-testid': 'boardsesh-grade' }),
}));

vi.mock('../../../providers/feature-flags-provider', () => ({
  useBoardseshGradeEnabled: () => flags.boardseshGrade,
}));

vi.mock('../../../lib/graphql/hooks', () => ({
  useBoardseshGrade: (boardName: string, climbUuid: string | null, angle: number, options?: { enabled?: boolean }) => {
    boardseshGradeQuery.calls.push({ boardName, climbUuid, angle, enabled: options?.enabled });
    return { data: boardseshGradeQuery.data };
  },
  useClimbStatsHistory: () => ({ data: undefined }),
  useFollowingClimbLogs: (boardName: string, climbUuid: string | null, options?: { enabled?: boolean }) => {
    crewQuery.calls.push({ boardName, climbUuid, enabled: options?.enabled });
    return { data: crewQuery.data };
  },
  useClimbLogsPreview: (args: { boardName: string; climbUuid: string | null; enabled: boolean }) => {
    everyoneQuery.calls.push(args);
    return { data: undefined };
  },
}));

vi.mock('../../../hooks/use-is-offline', () => ({ useIsOffline: () => everyoneQuery.offline }));

vi.mock('../../../hooks/use-climb-settled', () => ({
  useClimbSettled: (active: boolean, climbUuid: string) => {
    crewQuery.gateCalls.push({ active, climbUuid });
    return crewQuery.settled;
  },
}));

vi.mock('../../../lib/graphql/hooks/use-followed-authors', () => ({
  useFollowedAuthorsSnapshot: (options: { loadWhenMissing: boolean }) => {
    followedAuthors.calls.push(options);
    return followedAuthors.result;
  },
}));

vi.mock('../../../hooks/use-grade-format', () => ({
  useGradeFormat: () => ({ gradeFormat: 'v_grade' }),
}));

import { DeferredSections } from '../DeferredSections';

const climb = {
  uuid: 'climb-1',
  userAscents: 0,
  userAttempts: 0,
  quality_average: '3',
  ascensionist_count: 0,
} as Climb;

type RenderOptions = {
  enabled?: boolean;
  contentEnabled?: boolean;
  description?: string | null;
  climbOverrides?: Partial<Climb>;
  onOpenFullLogbook?: () => void;
  handlers?: {
    onOpenClimberLogs?: () => void;
    onOpenClimberProfile?: (userId: string) => void;
    onFindClimbers?: () => void;
  };
};

function renderSections(options: RenderOptions = {}) {
  const base = { ...climb, ...options.climbOverrides } as Climb;
  return render(
    <DeferredSections
      climb={options.description === undefined ? base : ({ ...base, description: options.description } as Climb)}
      boardName="kilter"
      layoutId={1}
      sizeId={10}
      setIds="1,2"
      angle={40}
      enabled={options.enabled ?? true}
      contentEnabled={options.contentEnabled ?? false}
      onSimilarClimbPress={vi.fn()}
      onOpenFullLogbook={options.onOpenFullLogbook}
      {...options.handlers}
    />,
  );
}

describe('DeferredSections', () => {
  beforeEach(() => {
    deferred.ready = false;
    deferred.calls = [];
    flags.boardseshGrade = false;
    boardseshGradeQuery.calls = [];
    boardseshGradeQuery.data = undefined;
    logbookSection.props = null;
    i18n.locale = null;
    auth.isAuthenticated = false;
    logbook.entries = [];
    crewQuery.settled = false;
    crewQuery.gateCalls = [];
    crewQuery.calls = [];
    crewQuery.data = undefined;
    everyoneQuery.calls = [];
    everyoneQuery.offline = false;
    followedAuthors.result = { data: undefined, isError: false };
    followedAuthors.calls = [];
    climberLogsSection.props = null;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('hands the Logbook card the board angle and the full-logbook opener', () => {
    const onOpenFullLogbook = vi.fn();
    renderSections({ onOpenFullLogbook });

    expect(logbookSection.props).toMatchObject({ climbUuid: 'climb-1', angle: 40, onOpenFullLogbook });
  });

  it('keeps the Logbook eager (the scroll hint) while heavier sections wait for scroll and interaction readiness', () => {
    renderSections({ contentEnabled: false });

    expect(screen.getByTestId('logbook')).not.toBeNull();
    expect(screen.queryByTestId('beta-videos')).toBeNull();
    expect(screen.queryByTestId('community')).toBeNull();
    expect(screen.queryByTestId('similar-climbs')).toBeNull();
    expect(deferred.calls.at(-1)).toEqual({ active: false, resetKey: 'climb-1' });
  });

  it('still waits for the interaction defer after the content is requested', () => {
    renderSections({ contentEnabled: true });

    expect(screen.getByTestId('logbook')).not.toBeNull();
    expect(screen.queryByTestId('beta-videos')).toBeNull();
    expect(deferred.calls.at(-1)).toEqual({ active: true, resetKey: 'climb-1' });
  });

  it('renders the heavier sections once both gates are open', () => {
    deferred.ready = true;
    renderSections({ contentEnabled: true });

    expect(screen.getByTestId('logbook')).not.toBeNull();
    expect(screen.getByTestId('beta-videos')).not.toBeNull();
    expect(screen.getByTestId('community')).not.toBeNull();
    expect(screen.getByTestId('similar-climbs')).not.toBeNull();
  });

  it('puts Similar climbs straight after Community, with the Logbook still first', () => {
    deferred.ready = true;
    const { container } = render(
      <DeferredSections
        climb={climb}
        boardName="kilter"
        layoutId={1}
        sizeId={10}
        setIds="1,2"
        angle={40}
        enabled
        contentEnabled
        onSimilarClimbPress={vi.fn()}
      />,
    );

    const order = [...container.querySelectorAll('[data-testid]')]
      .map((node) => node.getAttribute('data-testid'))
      .filter((id) => id !== 'text');
    expect(order[0]).toBe('logbook');
    expect(order.indexOf('similar-climbs')).toBe(order.indexOf('community') + 1);
  });

  it('hides the Boardsesh grade section when the flag is off', () => {
    deferred.ready = true;
    flags.boardseshGrade = false;
    renderSections({ contentEnabled: true });

    expect(screen.queryByTestId('boardsesh-grade')).toBeNull();
  });

  it('shows the Boardsesh grade section when the flag is on', () => {
    deferred.ready = true;
    flags.boardseshGrade = true;
    renderSections({ contentEnabled: true });

    expect(screen.getByTestId('boardsesh-grade')).not.toBeNull();
  });

  // #4494. The notes sit BELOW the Logbook on purpose: PlayDrawer's
  // `firstScreenReserve` / `computeLogbookScrollTarget` both assume the Logbook
  // is the first section rendered here, so anything inserted above it silently
  // breaks the fold math and the expand-into-view scroll.
  describe("the setter's notes", () => {
    function sectionTitles(container: HTMLElement): string[] {
      return [...container.querySelectorAll('section')].map((node) => node.getAttribute('data-title') ?? '');
    }

    it('renders the notes for a climb with real prose', () => {
      deferred.ready = true;
      const { container } = renderSections({ contentEnabled: true, description: 'Match the rail, then send.' });

      expect(container.textContent).toContain('Match the rail, then send.');
      expect(sectionTitles(container)).toContain('mobile.setterNotes.title');
    });

    it('keeps the Logbook first and puts the notes directly after it', () => {
      deferred.ready = true;
      const { container } = renderSections({ contentEnabled: true, description: 'Match the rail, then send.' });

      expect(sectionTitles(container).slice(0, 2)).toEqual(['mobile.logbook.title', 'mobile.setterNotes.title']);
    });

    it('leaves the Logbook first when there are no notes to show', () => {
      deferred.ready = true;
      const { container } = renderSections({ contentEnabled: true, description: '' });

      expect(sectionTitles(container)[0]).toBe('mobile.logbook.title');
    });

    it('renders no section at all for an empty or bare no-match description', () => {
      for (const description of ['', 'No match', 'No match\n', 'No matching.', 'no matching']) {
        deferred.ready = true;
        const { container, unmount } = renderSections({ contentEnabled: true, description });

        expect(sectionTitles(container)).not.toContain('mobile.setterNotes.title');
        unmount();
      }
    });

    it('never eats setter beta that merely mentions matching', () => {
      deferred.ready = true;
      const prose = 'No Houdini swap, spin around pls:). No matching.';
      const { container } = renderSections({ contentEnabled: true, description: prose });

      expect(container.textContent).toContain(prose);
    });

    it('waits for the interaction defer like the other below-fold sections', () => {
      deferred.ready = false;
      const { container } = renderSections({ contentEnabled: true, description: 'Match the rail, then send.' });

      expect(container.textContent).not.toContain('Match the rail, then send.');
    });
  });

  describe('the Climber logs card', () => {
    function sectionTitles(container: HTMLElement): string[] {
      return [...container.querySelectorAll('section')].map((node) => node.getAttribute('data-title') ?? '');
    }
    const follows = (...userIds: string[]) => ({
      data: { users: userIds.map((userId) => ({ userId })) },
      isError: false,
    });

    it('does not exist for a signed-out visitor, and asks for nothing', () => {
      deferred.ready = true;
      crewQuery.settled = true;
      followedAuthors.result = follows('friend');
      const { container } = renderSections({ contentEnabled: true });

      expect(screen.queryByTestId('climber-logs')).toBeNull();
      expect(sectionTitles(container)).not.toContain('mobile.climberLogs.title');
      expect(crewQuery.calls.every((call) => call.enabled === false)).toBe(true);
    });

    it('sends no request for an account that follows nobody, and still shows the card', () => {
      auth.isAuthenticated = true;
      deferred.ready = true;
      crewQuery.settled = true;
      followedAuthors.result = follows();
      renderSections({ contentEnabled: true });

      expect(crewQuery.calls.every((call) => call.enabled === false)).toBe(true);
      expect(climberLogsSection.props).toMatchObject({
        climbUuid: 'climb-1',
        boardName: 'kilter',
        angle: 40,
        followState: 'none',
        settled: true,
      });
    });

    it('hands the card the settle gate, so a climb swiped past sends nothing from it either', () => {
      auth.isAuthenticated = true;
      deferred.ready = true;
      crewQuery.settled = false;
      followedAuthors.result = follows();
      renderSections({ contentEnabled: true });

      expect(climberLogsSection.props).toMatchObject({ followState: 'none', settled: false });
    });

    it("hands the card the climb's grade id, or null for a grade it cannot read", () => {
      auth.isAuthenticated = true;
      deferred.ready = true;
      followedAuthors.result = follows();

      renderSections({ contentEnabled: true, climbOverrides: { difficulty: '6a/V3' } });
      expect(climberLogsSection.props?.climbGradeId).toEqual(expect.any(Number));

      renderSections({ contentEnabled: true, climbOverrides: { difficulty: 'project' } });
      expect(climberLogsSection.props?.climbGradeId).toBeNull();
    });

    it('waits for the open animation and the dwell before asking', () => {
      auth.isAuthenticated = true;
      crewQuery.settled = false;
      followedAuthors.result = follows('friend');
      renderSections({ contentEnabled: false });

      expect(crewQuery.gateCalls.at(-1)).toEqual({ active: true, climbUuid: 'climb-1' });
      expect(crewQuery.calls.at(-1)).toEqual({ boardName: 'kilter', climbUuid: 'climb-1', enabled: false });
    });

    it('asks once settled even before the first scroll, so the Logbook line above the fold can mention crew', () => {
      auth.isAuthenticated = true;
      crewQuery.settled = true;
      followedAuthors.result = follows('friend');
      renderSections({ contentEnabled: false });

      expect(crewQuery.calls.at(-1)?.enabled).toBe(true);
      // The card itself still waits for the scroll gate like every below-fold section.
      expect(screen.queryByTestId('climber-logs')).toBeNull();
    });

    // The request counts themselves are pinned against the real hooks in
    // climber-logs-request-counts.test.tsx; these cover the rule's inputs.
    describe("everyone else's newest logs, for the card's fall-through rows", () => {
      const crewAnswered = (climberCount: number) => ({
        items: [],
        hasMore: false,
        summary: { climberCount, senderCount: 0, byAngle: [] },
      });
      const arrangeSettled = (snapshot: typeof followedAuthors.result, crewData?: unknown) => {
        auth.isAuthenticated = true;
        crewQuery.settled = true;
        followedAuthors.result = snapshot;
        crewQuery.data = crewData;
      };

      it.each([
        ['an account that follows nobody', () => arrangeSettled(follows())],
        ['once the server says nobody followed logged it', () => arrangeSettled(follows('friend'), crewAnswered(0))],
        [
          'once the server says so, with no follow snapshot to go on',
          () => arrangeSettled({ data: undefined, isError: true }, crewAnswered(0)),
        ],
      ])('asks before the first scroll mounts the card: %s', (_label, arrange) => {
        arrange();
        renderSections({ contentEnabled: false });

        expect(screen.queryByTestId('climber-logs')).toBeNull();
        // The card's own read uses the same arguments, so one request serves both.
        expect(everyoneQuery.calls.at(-1)).toEqual({ boardName: 'kilter', climbUuid: 'climb-1', enabled: true });
      });

      it.each([
        ['while the followed-climbers answer is still out', () => arrangeSettled(follows('friend'))],
        ['when somebody followed has logged the climb', () => arrangeSettled(follows('friend'), crewAnswered(2))],
        [
          'when the follow snapshot failed and the server has not answered',
          () => arrangeSettled({ data: undefined, isError: true }),
        ],
        [
          // A cached "nobody logged it" answer must not stand in for a snapshot.
          'while the follow snapshot is still loading',
          () => arrangeSettled({ data: undefined, isError: false }, crewAnswered(0)),
        ],
        [
          'on a climb only swiped past',
          () => {
            arrangeSettled(follows());
            crewQuery.settled = false;
          },
        ],
        [
          'with no signal',
          () => {
            arrangeSettled(follows());
            everyoneQuery.offline = true;
          },
        ],
        [
          'for a signed-out visitor',
          () => {
            arrangeSettled(follows());
            auth.isAuthenticated = false;
          },
        ],
      ])('asks for nothing %s', (_label, arrange) => {
        deferred.ready = true;
        arrange();
        renderSections({ contentEnabled: true });

        expect(everyoneQuery.calls.length).toBeGreaterThan(0);
        expect(everyoneQuery.calls.every((call) => call.enabled === false)).toBe(true);
      });
    });

    it('only reads the follow snapshot, and holds a missing one back until the climb has settled', () => {
      auth.isAuthenticated = true;
      crewQuery.settled = false;
      const view = renderSections({ contentEnabled: false });
      expect(followedAuthors.calls.at(-1)).toEqual({ loadWhenMissing: false });
      view.unmount();

      crewQuery.settled = true;
      renderSections({ contentEnabled: false });
      expect(followedAuthors.calls.at(-1)).toEqual({ loadWhenMissing: true });
    });

    it('never loads the follow snapshot for a signed-out visitor', () => {
      crewQuery.settled = true;
      renderSections({ contentEnabled: true });

      expect(followedAuthors.calls.every((call) => !call.loadWhenMissing)).toBe(true);
    });

    it('neither asks nor shows the card while the follow snapshot is still loading', () => {
      auth.isAuthenticated = true;
      deferred.ready = true;
      crewQuery.settled = true;
      followedAuthors.result = { data: undefined, isError: false };
      renderSections({ contentEnabled: true });

      expect(crewQuery.calls.at(-1)?.enabled).toBe(false);
      expect(screen.queryByTestId('climber-logs')).toBeNull();
    });

    it('asks the server when the follow snapshot failed, and tells the card it does not know', () => {
      auth.isAuthenticated = true;
      deferred.ready = true;
      crewQuery.settled = true;
      followedAuthors.result = { data: undefined, isError: true };
      renderSections({ contentEnabled: true });

      expect(crewQuery.calls.at(-1)?.enabled).toBe(true);
      expect(climberLogsSection.props).toMatchObject({ followState: 'unknown' });
    });

    it('sits directly under the Logbook, above the setter notes and Beta Videos', () => {
      auth.isAuthenticated = true;
      deferred.ready = true;
      followedAuthors.result = follows('friend');
      const { container } = renderSections({ contentEnabled: true, description: 'Match the rail, then send.' });

      expect(sectionTitles(container).slice(0, 4)).toEqual([
        'mobile.logbook.title',
        'mobile.climberLogs.title',
        'mobile.setterNotes.title',
        'mobile.betaVideos.title',
      ]);
    });

    it('stays out of store captures', () => {
      vi.stubEnv('EXPO_PUBLIC_SCREENSHOT_MODE', '1');
      auth.isAuthenticated = true;
      deferred.ready = true;
      followedAuthors.result = follows('friend');
      renderSections({ contentEnabled: true });

      expect(screen.queryByTestId('climber-logs')).toBeNull();
    });

    it('hands the card the three openers', () => {
      auth.isAuthenticated = true;
      deferred.ready = true;
      followedAuthors.result = follows('friend');
      const handlers = { onOpenClimberLogs: vi.fn(), onOpenClimberProfile: vi.fn(), onFindClimbers: vi.fn() };
      renderSections({ contentEnabled: true, handlers });

      expect(climberLogsSection.props).toMatchObject({
        onSeeAll: handlers.onOpenClimberLogs,
        onPressClimber: handlers.onOpenClimberProfile,
        onFindClimbers: handlers.onFindClimbers,
      });
    });

    it('summarises the collapsed card from the server counts', () => {
      i18n.locale = 'en-US';
      auth.isAuthenticated = true;
      deferred.ready = true;
      followedAuthors.result = follows('friend');
      crewQuery.data = { items: [], hasMore: false, summary: { climberCount: 5, senderCount: 4, byAngle: [] } };
      const { container } = renderSections({ contentEnabled: true });

      expect(container.querySelector('[data-title="Climber logs"]')?.getAttribute('data-summary')).toBe(
        '5 you follow · 4 sent',
      );
    });
  });

  describe('the crew mention on the collapsed Logbook line', () => {
    const crewAnswer = (sendersAt40: number) => ({
      items: [],
      hasMore: false,
      summary: {
        climberCount: 5,
        senderCount: 4,
        byAngle: [
          { angle: 40, climberCount: 4, senderCount: sendersAt40 },
          { angle: 45, climberCount: 2, senderCount: 2 },
        ],
      },
    });
    const logged = { userAscents: 2, userAttempts: 3 };
    const sentAt45 = { climb_uuid: 'climb-1', angle: 45, status: 'send', tries: 1, climbed_at: '2026-01-01T00:00:00Z' };

    function logbookSummary(options: RenderOptions = {}): string | null {
      const { container, unmount } = renderSections({ climbOverrides: logged, ...options });
      const summary = container.querySelector('section')?.getAttribute('data-summary') ?? null;
      unmount();
      return summary;
    }

    beforeEach(() => {
      i18n.locale = 'en-US';
      auth.isAuthenticated = true;
      logbook.entries = [sentAt45];
    });

    it('reads exactly as before when there is no crew to mention', () => {
      const today = '40° · 2 sends · 3 attempts · sent at 45°';

      // No answer yet, or the request failed: `data` is undefined either way.
      crewQuery.data = undefined;
      expect(logbookSummary()).toBe(today);

      // Followed climbers logged it, but none sent it at this angle.
      crewQuery.data = crewAnswer(0);
      expect(logbookSummary()).toBe(today);

      // Nobody followed has logged it at all.
      crewQuery.data = { items: [], hasMore: false, summary: { climberCount: 0, senderCount: 0, byAngle: [] } };
      expect(logbookSummary()).toBe(today);
    });

    it('drops a cached crew mention once the viewer follows nobody', () => {
      followedAuthors.result = { data: { users: [] }, isError: false };
      crewQuery.data = crewAnswer(3);
      expect(logbookSummary()).toBe('40° · 2 sends · 3 attempts · sent at 45°');
    });

    it("puts the climber's own status first, then crew, then the other angles", () => {
      crewQuery.data = crewAnswer(3);
      expect(logbookSummary()).toBe('40° · 2 sends · 3 attempts · 3 crew sent · sent at 45°');
    });

    it('counts crew sends at the board angle only, and in the singular', () => {
      crewQuery.data = crewAnswer(1);
      logbook.entries = [];
      expect(logbookSummary({ climbOverrides: { userAscents: 0, userAttempts: 0 } })).toBe(
        '40° · not tried yet · 1 crew sent',
      );
    });

    it('keeps the own status ahead of the crew clause in German, where the line runs long', () => {
      i18n.locale = 'de';
      crewQuery.data = crewAnswer(3);
      const summary = logbookSummary() ?? '';

      expect(summary).toBe('40° · 2 Begehungen · 3 Versuche · 3 aus der Crew getoppt · getoppt bei 45°');
      expect(summary.indexOf('2 Begehungen')).toBeLessThan(summary.indexOf('aus der Crew'));
    });
  });

  it('renders nothing while disabled', () => {
    const { container } = renderSections({ enabled: false, contentEnabled: true });

    expect(container.childElementCount).toBe(0);
  });
});
