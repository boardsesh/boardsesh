// @vitest-environment jsdom
vi.mock('../../AccessibleTextInput', async () => {
  const { TextInput } = await import('react-native');
  return { AccessibleTextInput: TextInput };
});
vi.mock('../../../hooks/use-bold-text', () => ({ useBoldText: () => false }));
vi.mock('../../PressableSurface', async () => {
  const { Pressable } = await import('react-native');
  const { createElement } = await import('react');
  return {
    PressableSurface: (props: React.ComponentProps<typeof Pressable>) =>
      createElement(Pressable, { ...props, onPress: props.disabled ? undefined : props.onPress }),
  };
});
import { createElement, type ReactNode } from 'react';
import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BoardName, Climb } from '@boardsesh/shared-schema';

const deferred = vi.hoisted(() => ({
  ready: false,
  calls: [] as Array<{ active: boolean; resetKey: string | number | undefined }>,
}));

const flags = vi.hoisted(() => ({ boardseshGrade: false }));

// The reads behind the collapsed lines: what each was asked with, and what it answers.
const lineQueries = vi.hoisted(() => ({
  history: {
    calls: [] as Array<{ climbUuid: string | null; enabled: boolean | undefined }>,
    data: undefined as unknown,
  },
  beta: { calls: [] as Array<{ climbUuid: string; enabled: boolean | undefined }>, data: undefined as unknown },
  similar: {
    calls: [] as Array<{ climbUuid: string | null; angle: number }>,
    data: undefined as unknown,
    source: 'local' as 'local' | 'network' | 'download',
  },
}));

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
  DynamicColorIOS: (appearances: { light: string }) => appearances.light,
  PlatformColor: (name: string) => name,
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  Pressable: ({ children }: { children?: ReactNode }) => createElement('button', null, children),
  StyleSheet: {
    flatten: (style: unknown) => Object.assign({}, ...[style].flat(10).filter(Boolean)),
    create: (styles: unknown) => styles,
  },
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
const logbook = vi.hoisted(() => ({
  entries: [] as unknown[],
  calls: [] as Array<{ boardName: string | null; climbUuids: string[] }>,
}));
vi.mock('@boardsesh/board-react', () => ({
  useLogbook: (boardName: string | null, climbUuids: string[]) => {
    logbook.calls.push({ boardName, climbUuids });
    return { logbook: logbook.entries, isLoading: false };
  },
}));
vi.mock('../../Icon', () => ({ Icon: () => null }));
const auth = vi.hoisted(() => ({ isAuthenticated: false }));
vi.mock('../../../providers/auth-provider', () => ({ useAuth: () => ({ isAuthenticated: auth.isAuthenticated }) }));
vi.mock('../../../providers/theme-provider', () => ({
  useOptionalTheme: () => null,
  useTheme: () => ({ brandColors: { primary: '#000' } }),
}));

vi.mock('../../../hooks/use-deferred-after-interactions', () => ({
  useDeferredAfterInteractions: (active: boolean, resetKey?: string | number) => {
    deferred.calls.push({ active, resetKey });
    return deferred.ready;
  },
}));

// The saved expand state the peek's request gate reads, and the headers show.
const expandState = vi.hoisted(() => ({ map: {} as Record<string, boolean>, loaded: true }));
vi.mock('../../../lib/section-expand-store', () => ({
  useSectionExpanded: (key: string | undefined) => ({
    expanded: key === undefined ? undefined : expandState.map[key],
    loaded: expandState.loaded,
  }),
}));

// Draws the line only while collapsed, as the real header does. Children always
// render, so the body tests can see what each section is handed.
vi.mock('../../CollapsibleSection', () => ({
  CollapsibleSection: ({
    title,
    summary,
    children,
    onHeaderLayout,
    persistKey,
    defaultExpanded = false,
  }: {
    title: string;
    summary?: string | null;
    children?: ReactNode;
    onHeaderLayout?: (height: number) => void;
    persistKey?: string;
    defaultExpanded?: boolean;
  }) => {
    onHeaderLayout?.(44);
    const expanded = (persistKey ? expandState.map[persistKey] : undefined) ?? defaultExpanded;
    return createElement(
      'section',
      { 'data-title': title, 'data-summary': expanded ? undefined : (summary ?? undefined) },
      children,
    );
  },
}));

// SetterNotesSection renders through the real component (its suppression rules
// are what these tests assert), so only the leaf Text needs a DOM stand-in.
vi.mock('../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('p', { 'data-testid': 'text' }, children),
}));

// Its own suite covers the markers; here only whether it mounts, and what it reads.
const activeHoldsSection = vi.hoisted(() => ({ props: null as Record<string, unknown> | null }));
vi.mock('../ActiveHoldsSection', () => ({
  ActiveHoldsSection: (props: Record<string, unknown> & { onHeaderLayout?: (height: number) => void }) => {
    activeHoldsSection.props = props;
    props.onHeaderLayout?.(44);
    return createElement('section', { 'data-testid': 'active-holds' });
  },
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
  useClimbStatsHistory: (_boardName: string, climbUuid: string | null, options?: { enabled?: boolean }) => {
    lineQueries.history.calls.push({ climbUuid, enabled: options?.enabled });
    return { data: lineQueries.history.data };
  },
  useBetaLinks: (_boardName: string, climbUuid: string, enabled?: boolean) => {
    lineQueries.beta.calls.push({ climbUuid, enabled });
    return { data: lineQueries.beta.data };
  },
  useFollowingClimbLogs: (boardName: string, climbUuid: string | null, options?: { enabled?: boolean }) => {
    crewQuery.calls.push({ boardName, climbUuid, enabled: options?.enabled });
    return { data: crewQuery.data };
  },
  useClimbLogsPreview: (args: { boardName: string; climbUuid: string | null; enabled: boolean }) => {
    everyoneQuery.calls.push(args);
    return { data: undefined };
  },
}));

vi.mock('../../../lib/graphql/hooks/use-similar-climbs', () => ({
  useSimilarClimbs: (_scope: unknown, climbUuid: string | null, angle: number) => {
    lineQueries.similar.calls.push({ climbUuid, angle });
    return { data: lineQueries.similar.data, source: lineQueries.similar.source, isResolvingSource: false };
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
import { PlaybackFrameContext } from '../playback-frame-context';
import {
  DEFAULT_PLAY_DRAWER_SECTIONS,
  type BelowFoldSectionId,
  type PlayDrawerSectionsVisibility,
} from '../../../lib/play-drawer-sections-preference';

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
  sections?: PlayDrawerSectionsVisibility;
  order?: readonly BelowFoldSectionId[];
  onFirstSectionHeaderLayout?: (height: number) => void;
  description?: string | null;
  climbOverrides?: Partial<Climb>;
  onOpenFullLogbook?: () => void;
  boardName?: BoardName;
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
      boardName={options.boardName ?? 'kilter'}
      layoutId={1}
      sizeId={10}
      setIds="1,2"
      angle={40}
      enabled={options.enabled ?? true}
      contentEnabled={options.contentEnabled ?? false}
      sections={options.sections}
      order={options.order}
      onFirstSectionHeaderLayout={options.onFirstSectionHeaderLayout}
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
    logbook.calls = [];
    crewQuery.settled = false;
    crewQuery.gateCalls = [];
    crewQuery.calls = [];
    crewQuery.data = undefined;
    everyoneQuery.calls = [];
    everyoneQuery.offline = false;
    followedAuthors.result = { data: undefined, isError: false };
    followedAuthors.calls = [];
    climberLogsSection.props = null;
    expandState.map = {};
    expandState.loaded = true;
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

  // Notes retain their position after Logbook when both are enabled.
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
      expandState.map = { climberLogs: false };
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
      logbook.calls = [];
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

describe('DeferredSections visibility preferences', () => {
  const hiddenSections: PlayDrawerSectionsVisibility = {
    activeHolds: false,
    logbook: false,
    climberLogs: false,
    setterNotes: false,
    betaVideos: false,
    boardseshGrade: false,
    community: false,
    similarClimbs: false,
  };
  beforeEach(() => {
    deferred.ready = false;
    auth.isAuthenticated = true;
    flags.boardseshGrade = true;
    crewQuery.settled = true;
    crewQuery.calls = [];
    everyoneQuery.calls = [];
    followedAuthors.calls = [];
    followedAuthors.result = { data: { users: [] }, isError: false };
    boardseshGradeQuery.calls = [];
    logbook.calls = [];
    logbookSection.props = null;
    activeHoldsSection.props = null;
  });
  it('never mounts Active holds while it is off, as it is by default', () => {
    deferred.ready = true;
    renderSections({ contentEnabled: true });
    expect(screen.queryByTestId('active-holds')).toBeNull();
    expect(activeHoldsSection.props).toBeNull();
  });
  it('makes Active holds the measured peek on a MoonBoard climb, reading it on its board and asking for nothing', () => {
    lineQueries.history.calls = [];
    lineQueries.beta.calls = [];
    const onFirstSectionHeaderLayout = vi.fn();
    renderSections({
      boardName: 'moonboard',
      sections: { ...DEFAULT_PLAY_DRAWER_SECTIONS, activeHolds: true },
      onFirstSectionHeaderLayout,
    });
    expect(screen.getByTestId('active-holds')).toBeDefined();
    expect(activeHoldsSection.props).toMatchObject({ boardName: 'moonboard', layoutId: 1, frames: climb.frames });
    expect(onFirstSectionHeaderLayout).toHaveBeenCalledWith(44);
    // The Logbook below it waits for scrolling, and nothing is fetched for a frames read.
    expect(screen.queryByTestId('logbook')).toBeNull();
    expect(logbook.calls.every(({ boardName }) => boardName === null)).toBe(true);
    expect(boardseshGradeQuery.calls.every(({ enabled }) => !enabled)).toBe(true);
    expect(lineQueries.history.calls.every(({ enabled }) => !enabled)).toBe(true);
    expect(lineQueries.beta.calls.every(({ enabled }) => !enabled)).toBe(true);
    expect(crewQuery.calls.every(({ enabled }) => !enabled)).toBe(true);
  });
  it('leaves Active holds out on another board, switched on or not, so Logbook is the peek', () => {
    const onFirstSectionHeaderLayout = vi.fn();
    renderSections({ sections: { ...DEFAULT_PLAY_DRAWER_SECTIONS, activeHolds: true }, onFirstSectionHeaderLayout });
    expect(screen.queryByTestId('active-holds')).toBeNull();
    expect(activeHoldsSection.props).toBeNull();
    expect(onFirstSectionHeaderLayout).toHaveBeenCalledWith(44);
    expect(document.querySelector('section')?.getAttribute('data-title')).toBe('mobile.logbook.title');
  });
  it('lets a playback frame reach Active holds without re-rendering the sections', () => {
    deferred.ready = true;
    const props = {
      climb,
      boardName: 'moonboard' as const,
      layoutId: 1,
      sizeId: 10,
      setIds: '1,2',
      angle: 40,
      enabled: true,
      contentEnabled: true,
      sections: { ...DEFAULT_PLAY_DRAWER_SECTIONS, activeHolds: true },
      onSimilarClimbPress: vi.fn(),
    };
    const tree = (frame: string) => (
      <PlaybackFrameContext.Provider value={frame}>
        <DeferredSections {...props} />
      </PlaybackFrameContext.Provider>
    );
    const view = render(tree('p1r12'));
    expect(screen.getByTestId('logbook')).toBeDefined();
    const sectionRenders = deferred.calls.length;
    const logbookProps = logbookSection.props;
    view.rerender(tree('p2r12'));
    // Neither DeferredSections nor the Logbook below it ran again.
    expect(deferred.calls.length).toBe(sectionRenders);
    expect(logbookSection.props).toBe(logbookProps);
  });
  it('mounts Active holds further down only once the climber scrolls to it', () => {
    const order: BelowFoldSectionId[] = [
      'logbook',
      'climberLogs',
      'setterNotes',
      'betaVideos',
      'boardseshGrade',
      'community',
      'similarClimbs',
      'activeHolds',
    ];
    const sections = { ...DEFAULT_PLAY_DRAWER_SECTIONS, activeHolds: true };
    const view = renderSections({ boardName: 'moonboard', sections, order });
    expect(activeHoldsSection.props).toBeNull();
    deferred.ready = true;
    view.unmount();
    renderSections({ boardName: 'moonboard', sections, order, contentEnabled: true });
    expect(screen.getByTestId('active-holds')).toBeDefined();
  });
  it('mounts and measures a Beta header eagerly without mounting its body', () => {
    const onFirstSectionHeaderLayout = vi.fn();
    const { container } = renderSections({
      sections: { ...hiddenSections, betaVideos: true },
      onFirstSectionHeaderLayout,
    });
    expect(container.querySelector('[data-title="mobile.betaVideos.title"]')).not.toBeNull();
    expect(onFirstSectionHeaderLayout).toHaveBeenCalledWith(44);
    expect(screen.queryByTestId('beta-videos')).toBeNull();
    expect(screen.queryByTestId('logbook')).toBeNull();
    expect(logbook.calls.every(({ boardName, climbUuids }) => boardName === null && climbUuids.length === 0)).toBe(
      true,
    );
    expect(crewQuery.calls.every(({ enabled }) => !enabled)).toBe(true);
    expect(everyoneQuery.calls).toHaveLength(0);
    expect(followedAuthors.calls.every(({ loadWhenMissing }) => !loadWhenMissing)).toBe(true);
  });
  it('mounts the selected body once scrolling and interaction gates open', () => {
    deferred.ready = true;
    renderSections({ sections: { ...hiddenSections, betaVideos: true }, contentEnabled: true });
    expect(screen.getByTestId('beta-videos')).toBeDefined();
    expect(screen.queryByTestId('community')).toBeNull();
    expect(screen.queryByTestId('logbook')).toBeNull();
    expect(boardseshGradeQuery.calls.every(({ enabled }) => !enabled)).toBe(true);
  });
  it('all-hidden renders no padding container and disables section queries', () => {
    const { container } = renderSections({ sections: hiddenSections, contentEnabled: true });
    expect(container.childElementCount).toBe(0);
    expect(logbook.calls.every(({ boardName }) => boardName === null)).toBe(true);
    expect(boardseshGradeQuery.calls.every(({ enabled }) => !enabled)).toBe(true);
    expect(crewQuery.calls.every(({ enabled }) => !enabled)).toBe(true);
    expect(everyoneQuery.calls).toHaveLength(0);
  });
  it('preserves crew reads for visible Logbook while suppressing hidden everyone-log prefetch', () => {
    followedAuthors.result = { data: { users: [{ userId: 'friend' }] }, isError: false };
    renderSections({ sections: { ...DEFAULT_PLAY_DRAWER_SECTIONS, climberLogs: false } });
    expect(crewQuery.calls.at(-1)?.enabled).toBe(true);
    expect(logbook.calls.at(-1)?.boardName).toBe('kilter');
    expect(everyoneQuery.calls).toHaveLength(0);
  });
  it('an eligible Climber logs header can measure before the followed snapshot arrives', () => {
    followedAuthors.result = { data: undefined, isError: false };
    const onFirstSectionHeaderLayout = vi.fn();
    const { container } = renderSections({
      sections: { ...hiddenSections, climberLogs: true },
      onFirstSectionHeaderLayout,
    });
    expect(container.querySelector('[data-title="mobile.climberLogs.title"]')).not.toBeNull();
    expect(onFirstSectionHeaderLayout).toHaveBeenCalledWith(44);
    expect(screen.queryByTestId('climber-logs')).toBeNull();
  });
  it('empty notes alone leave no container or scroll hint', () => {
    const { container } = renderSections({
      sections: { ...hiddenSections, setterNotes: true },
      description: 'No match',
    });
    expect(container.childElementCount).toBe(0);
  });

  describe("in the climber's order", () => {
    const SIMILAR_FIRST: BelowFoldSectionId[] = [
      'similarClimbs',
      'community',
      'boardseshGrade',
      'betaVideos',
      'setterNotes',
      'climberLogs',
      'logbook',
    ];
    const sectionTitles = (container: HTMLElement) =>
      [...container.querySelectorAll('section[data-title]')].map((node) => node.getAttribute('data-title'));

    it('draws the sections in that order', () => {
      deferred.ready = true;
      const { container } = renderSections({
        order: SIMILAR_FIRST,
        contentEnabled: true,
        description: 'Left hand first.',
      });
      expect(sectionTitles(container)).toEqual([
        'mobile.similarClimbs.title',
        'mobile.community.title',
        'boardseshGrade.title',
        'mobile.betaVideos.title',
        'mobile.setterNotes.title',
        'mobile.climberLogs.title',
        'mobile.logbook.title',
      ]);
    });

    it('mounts only the first header at the fold; Logbook waits like the rest when it is not first', () => {
      const onFirstSectionHeaderLayout = vi.fn();
      const { container } = renderSections({ order: SIMILAR_FIRST, onFirstSectionHeaderLayout });
      expect(sectionTitles(container)).toEqual(['mobile.similarClimbs.title']);
      expect(onFirstSectionHeaderLayout).toHaveBeenCalledWith(44);
      expect(screen.queryByTestId('similar-climbs')).toBeNull();
      expect(screen.queryByTestId('logbook')).toBeNull();
    });

    it('starts no query for a hidden section wherever it sits', () => {
      deferred.ready = true;
      renderSections({
        order: SIMILAR_FIRST,
        sections: { ...DEFAULT_PLAY_DRAWER_SECTIONS, logbook: false, climberLogs: false, boardseshGrade: false },
        contentEnabled: true,
      });
      expect(logbook.calls.every(({ boardName }) => boardName === null)).toBe(true);
      expect(boardseshGradeQuery.calls.every(({ enabled }) => !enabled)).toBe(true);
      expect(everyoneQuery.calls).toHaveLength(0);
      expect(screen.getByTestId('similar-climbs')).not.toBeNull();
    });
  });
});

describe('collapsed lines, and what each section may ask for', () => {
  const ORDER: BelowFoldSectionId[] = [
    'logbook',
    'climberLogs',
    'setterNotes',
    'betaVideos',
    'boardseshGrade',
    'community',
    'similarClimbs',
  ];
  const first = (sectionId: BelowFoldSectionId): BelowFoldSectionId[] => [
    sectionId,
    ...ORDER.filter((other) => other !== sectionId),
  ];
  const summaryOf = (container: HTMLElement, title: string) =>
    container.querySelector(`section[data-title="${title}"]`)?.getAttribute('data-summary') ?? null;
  const historyEntry = (angle: number, ascensionistCount: number) => ({
    angle,
    ascensionistCount,
    qualityAverage: 3,
    difficultyAverage: 20,
    displayDifficulty: 20,
    createdAt: '2026-10-01T00:00:00Z',
  });

  beforeEach(() => {
    deferred.ready = false;
    i18n.locale = 'en-US';
    auth.isAuthenticated = true;
    flags.boardseshGrade = true;
    crewQuery.settled = true;
    crewQuery.calls = [];
    crewQuery.data = undefined;
    everyoneQuery.calls = [];
    everyoneQuery.offline = false;
    followedAuthors.result = { data: { users: [{ userId: 'friend' }] }, isError: false };
    logbook.calls = [];
    boardseshGradeQuery.calls = [];
    lineQueries.history = { calls: [], data: undefined };
    lineQueries.beta = { calls: [], data: undefined };
    lineQueries.similar = { calls: [], data: undefined, source: 'local' };
    crewQuery.gateCalls = [];
    expandState.loaded = true;
    expandState.map = {
      betaVideos: false,
      community: false,
      boardseshGrade: false,
      similarClimbs: false,
      setterNotes: false,
    };
  });

  afterEach(() => {
    expandState.map = {};
  });

  it.each([
    ['Beta Videos', 'betaVideos' as const, () => lineQueries.beta.calls],
    ['Community', 'community' as const, () => lineQueries.history.calls],
  ])('%s as an open peek draws no line, so asks for none', (_label, sectionId, calls) => {
    expandState.map = { ...expandState.map, [sectionId]: true };
    renderSections({ order: first(sectionId) });
    expect(calls().every(({ enabled }) => !enabled)).toBe(true);
  });

  it.each([
    ['Beta Videos', 'betaVideos' as const, () => lineQueries.beta.calls],
    ['Community', 'community' as const, () => lineQueries.history.calls],
  ])('%s as a peek that has never been touched starts open, so asks for nothing', (_label, sectionId, calls) => {
    expandState.map = {};
    renderSections({ order: first(sectionId) });
    expect(calls().every(({ enabled }) => !enabled)).toBe(true);
  });

  it('asks for nothing while the saved expand state is still loading', () => {
    expandState.loaded = false;
    renderSections({ order: first('community') });
    expect(lineQueries.history.calls.every(({ enabled }) => !enabled)).toBe(true);
    expect(crewQuery.gateCalls.every(({ active }) => !active)).toBe(true);
  });

  it.each(['community', 'similarClimbs', 'boardseshGrade'] as const)(
    'turns the settle gate on for a collapsed %s peek, and off for an open one',
    (sectionId) => {
      renderSections({ order: first(sectionId) });
      expect(crewQuery.gateCalls.at(-1)?.active).toBe(true);
      crewQuery.gateCalls = [];
      expandState.map = { ...expandState.map, [sectionId]: true };
      renderSections({ order: first(sectionId) });
      expect(crewQuery.gateCalls.at(-1)?.active).toBe(false);
    },
  );

  it("Setter's notes show their first written line", () => {
    const { container } = renderSections({
      order: first('setterNotes'),
      description: 'No match\n\n  Start left, cross to the pinch.\nThen match the jug.',
    });
    expect(summaryOf(container, 'mobile.setterNotes.title')).toBe('Start left, cross to the pinch.');
  });

  it('Beta Videos as the peek ask for the videos once settled and count them', () => {
    lineQueries.beta.data = [{}, {}, {}];
    const { container } = renderSections({ order: first('betaVideos') });
    expect(lineQueries.beta.calls.at(-1)).toEqual({ climbUuid: 'climb-1', enabled: true });
    expect(summaryOf(container, 'Beta Videos')).toBe('3 videos');
  });

  it('Beta Videos as the peek with no signal ask for nothing and show no line', () => {
    everyoneQuery.offline = true;
    const { container } = renderSections({ order: first('betaVideos') });
    expect(lineQueries.beta.calls.length).toBeGreaterThan(0);
    expect(lineQueries.beta.calls.every(({ enabled }) => !enabled)).toBe(true);
    expect(summaryOf(container, 'Beta Videos')).toBeNull();
  });

  it('Beta Videos say when there are none, so the shelf is never opened for nothing', () => {
    lineQueries.beta.data = [];
    const { container } = renderSections({ order: first('betaVideos') });
    expect(summaryOf(container, 'Beta Videos')).toBe('None yet');
  });

  it.each([
    ['on a climb only swiped past', () => (crewQuery.settled = false)],
    ['with no signal', () => (everyoneQuery.offline = true)],
  ])('Beta Videos as the peek ask for nothing %s', (_label, arrange) => {
    arrange();
    renderSections({ order: first('betaVideos') });
    expect(lineQueries.beta.calls.every(({ enabled }) => !enabled)).toBe(true);
  });

  it('Community as the peek names the angle most climbers sent it at', () => {
    lineQueries.history.data = [historyEntry(35, 12), historyEntry(40, 410), historyEntry(45, 90)];
    const { container } = renderSections({ order: first('community') });
    expect(lineQueries.history.calls.at(-1)).toEqual({ climbUuid: 'climb-1', enabled: true });
    expect(summaryOf(container, 'Community')).toBe('Most sends at 40°');
  });

  it('Community shows no line until there is a send to point at', () => {
    lineQueries.history.data = [historyEntry(40, 0)];
    const { container } = renderSections({ order: first('community') });
    expect(summaryOf(container, 'Community')).toBeNull();
  });

  it('Similar climbs as the peek name the closest match its first card shows', () => {
    lineQueries.similar.data = [
      { uuid: 'a', name: 'Off the wall', compatibleSizeIds: [99] },
      { uuid: 'b', name: 'Guessing Games', compatibleSizeIds: [10] },
    ];
    const { container } = renderSections({ order: first('similarClimbs') });
    expect(lineQueries.similar.calls.at(-1)).toEqual({ climbUuid: 'climb-1', angle: 40 });
    expect(summaryOf(container, 'Similar Climbs')).toBe('Closest: Guessing Games');
  });

  it('Similar climbs say the board needs downloading when that is why there is nothing', () => {
    lineQueries.similar.source = 'download';
    const { container } = renderSections({ order: first('similarClimbs') });
    expect(summaryOf(container, 'Similar Climbs')).toBe('Download to see them');
  });

  it('Similar climbs show no line while the answer is still out', () => {
    const { container } = renderSections({ order: first('similarClimbs') });
    expect(summaryOf(container, 'Similar Climbs')).toBeNull();
  });

  it('Similar climbs say when nothing matched', () => {
    lineQueries.similar.data = [];
    const { container } = renderSections({ order: first('similarClimbs') });
    expect(summaryOf(container, 'Similar Climbs')).toBe('None found');
  });

  it('Boardsesh grade as the peek asks for its grade once settled, before any scroll', () => {
    renderSections({ order: first('boardseshGrade') });
    expect(boardseshGradeQuery.calls.at(-1)?.enabled).toBe(true);
  });

  it('a section below the fold asks for nothing until the climber scrolls to it', () => {
    const order: BelowFoldSectionId[] = [
      'setterNotes',
      'betaVideos',
      'boardseshGrade',
      'community',
      'similarClimbs',
      'climberLogs',
      'logbook',
    ];
    renderSections({ order, description: 'Left hand first.' });
    expect(logbook.calls.every(({ boardName }) => boardName === null)).toBe(true);
    expect(crewQuery.calls.every(({ enabled }) => !enabled)).toBe(true);
    expect(everyoneQuery.calls).toHaveLength(0);
    expect(lineQueries.beta.calls.every(({ enabled }) => !enabled)).toBe(true);
    expect(lineQueries.history.calls.every(({ enabled }) => !enabled)).toBe(true);
    expect(boardseshGradeQuery.calls.every(({ enabled }) => !enabled)).toBe(true);
    expect(lineQueries.similar.calls).toHaveLength(0);
  });

  it('a hidden section asks for nothing even as the peek would', () => {
    renderSections({
      order: first('similarClimbs'),
      sections: { ...DEFAULT_PLAY_DRAWER_SECTIONS, similarClimbs: false, betaVideos: false, community: false },
      contentEnabled: true,
    });
    expect(lineQueries.similar.calls).toHaveLength(0);
    expect(lineQueries.beta.calls.every(({ enabled }) => !enabled)).toBe(true);
  });

  it('a section further down shows a line only from what is already cached', () => {
    deferred.ready = true;
    lineQueries.history.data = [historyEntry(30, 5), historyEntry(25, 40)];
    lineQueries.beta.data = [{}];
    const { container } = renderSections({ order: ORDER, contentEnabled: true });
    expect(lineQueries.history.calls.at(-1)?.enabled).toBe(true); // the Boardsesh grade, now on screen, asks
    expect(lineQueries.beta.calls.every(({ enabled }) => !enabled)).toBe(true);
    expect(summaryOf(container, 'Community')).toBe('Most sends at 25°');
    expect(summaryOf(container, 'Beta Videos')).toBe('1 video');
    expect(lineQueries.similar.calls).toHaveLength(0);
  });

  it('keeps the Logbook peek reading its ticks and the crew, as before', () => {
    renderSections({ order: ORDER });
    expect(logbook.calls.at(-1)?.boardName).toBe('kilter');
    expect(crewQuery.calls.at(-1)?.enabled).toBe(true);
  });
});
