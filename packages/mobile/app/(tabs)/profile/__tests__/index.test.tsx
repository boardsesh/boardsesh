// @vitest-environment jsdom
//
// Own-profile ("You" tab) parity regression guard for #3049: a "Climbs"
// (created-climbs) tab shipped on the public/other-user profile screen
// (app/users/[userId]/index.tsx) but was never wired into this own-profile
// screen, so a climber's own created climbs never appeared here even though
// they showed up fine when viewing someone else's profile. This test fails
// on a revert of that wiring.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, act } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

type ListScrollHandler = (event: { nativeEvent: { contentOffset: { x: number; y: number } } }) => void;

const ctrl = vi.hoisted(() => ({
  profileId: 'user-own-123' as string | undefined,
  measureProfile: undefined as ((height: number) => void) | undefined,
  measureLogbook: undefined as ((height: number) => void) | undefined,
  logbookHeightChange: vi.fn(),
  // The UIKit header path (iOS on Liquid Glass): the lists sit under a floating
  // segmented control, and rest at minus the header's height.
  nativeRootHeader: false,
  listTopOffset: 0,
  // The scroll handler each mounted sub-tab's list was given.
  listScroll: {} as Record<string, ListScrollHandler | undefined>,
}));

const rendered = vi.hoisted(() => ({
  progress: [] as Array<{ userId: string | undefined; topInset: number }>,
  sessions: [] as Array<{ userId: string | undefined }>,
  logbook: [] as Array<{ userId: string | undefined }>,
  climbs: [] as Array<{ userId: string | undefined }>,
  social: [] as Array<{ userId: string | undefined }>,
}));

vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles },
}));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock('expo-router', () => ({
  router: { push: vi.fn() },
  useLocalSearchParams: () => ({ screenshotTab: undefined }),
}));
vi.mock('../../../../src/lib/graphql/hooks', () => ({
  useProfile: () => ({ data: ctrl.profileId ? { id: ctrl.profileId } : undefined }),
  useYouProfileData: () => ({
    hasActiveFilters: false,
    selectedBoard: 'all',
    setSelectedBoard: vi.fn(),
    timeframe: 'all',
    setTimeframe: vi.fn(),
  }),
}));
vi.mock('../../../../src/providers/theme-provider', () => ({
  useTheme: () => ({ systemColors: { background: '#fff' } }),
}));
vi.mock('../../../../src/hooks/use-native-root-header', () => ({
  useNativeRootHeader: () => ctrl.nativeRootHeader,
}));
vi.mock('../../../../src/hooks/use-list-top-offset', () => ({ useListTopOffset: () => ctrl.listTopOffset }));
// Stand-in top chrome: exposes one button per known tab key so the test can
// drive tab selection the same way a real tap would, without pulling in the
// real chrome's native segmented control / app bar machinery.
vi.mock('../../../../src/components/you/ProfileTopChrome', () => ({
  ProfileTopChrome: ({
    activeTab,
    onSelectTab,
    onHeightChange,
    children,
    opaqueControls,
    scrolledUnder,
  }: {
    activeTab: string;
    onSelectTab: (key: string) => void;
    onHeightChange: (height: number) => void;
    children?: ReactNode;
    opaqueControls?: boolean;
    scrolledUnder?: boolean;
  }) => {
    if (activeTab === 'logbook') ctrl.measureLogbook = onHeightChange;
    else ctrl.measureProfile = onHeightChange;
    return createElement(
      'div',
      {
        'data-chrome': 'true',
        'data-active-tab': activeTab,
        'data-opaque-controls': String(opaqueControls === true),
        'data-scrolled-under': String(scrolledUnder),
      },
      ['progress', 'sessions', 'logbook', 'climbs', 'social'].map((key) =>
        createElement('button', { key, 'data-select-tab': key, onClick: () => onSelectTab(key) }, key),
      ),
      children,
    );
  },
}));
vi.mock('../../../../src/components/you/YouFilterSheet', () => ({
  YouFilterSheet: () => createElement('div', { 'data-filter-sheet': 'true' }),
}));
vi.mock('../../../../src/components/you/ProgressTab', () => ({
  ProgressTab: ({
    userId,
    topInset,
    onScroll,
  }: {
    userId: string | undefined;
    topInset: number;
    onScroll?: ListScrollHandler;
  }) => {
    ctrl.listScroll.progress = onScroll;
    rendered.progress.push({ userId, topInset });
    return createElement('div', { 'data-tab': 'progress' });
  },
}));
vi.mock('../../../../src/components/you/SessionsTab', () => ({
  SessionsTab: ({ userId, onScroll }: { userId: string | undefined; onScroll?: ListScrollHandler }) => {
    ctrl.listScroll.sessions = onScroll;
    rendered.sessions.push({ userId });
    return createElement('div', { 'data-tab': 'sessions' });
  },
}));
vi.mock('../../../../src/components/you/LogbookTab', () => ({
  LogbookTab: ({
    userId,
    renderHeader,
  }: {
    userId: string | undefined;
    renderHeader?: (controls: ReactNode, onHeightChange: (height: number) => void) => ReactNode;
  }) => {
    rendered.logbook.push({ userId });
    return createElement(
      'div',
      { 'data-tab': 'logbook' },
      renderHeader?.(createElement('div', { 'data-logbook-controls': 'true' }), ctrl.logbookHeightChange),
    );
  },
}));
vi.mock('../../../../src/components/you/ProfileClimbsTab', () => ({
  ProfileClimbsTab: ({ userId, onScroll }: { userId: string | undefined; onScroll?: ListScrollHandler }) => {
    ctrl.listScroll.climbs = onScroll;
    rendered.climbs.push({ userId });
    return createElement('div', { 'data-tab': 'climbs' });
  },
}));
vi.mock('../../../../src/components/you/SocialTab', () => ({
  SocialTab: ({ userId, onScroll }: { userId: string | undefined; onScroll?: ListScrollHandler }) => {
    ctrl.listScroll.social = onScroll;
    rendered.social.push({ userId });
    return createElement('div', { 'data-tab': 'social' });
  },
}));

import YouScreen from '../index';

describe('YouScreen (own profile)', () => {
  beforeEach(() => {
    ctrl.profileId = 'user-own-123';
    ctrl.measureProfile = undefined;
    ctrl.measureLogbook = undefined;
    ctrl.logbookHeightChange.mockClear();
    ctrl.nativeRootHeader = false;
    ctrl.listTopOffset = 0;
    ctrl.listScroll = {};
    rendered.progress = [];
    rendered.sessions = [];
    rendered.logbook = [];
    rendered.climbs = [];
    rendered.social = [];
  });

  it('offers a Climbs tab alongside progress/sessions/logbook/social', () => {
    const { container } = render(<YouScreen />);
    const keys = Array.from(container.querySelectorAll('[data-select-tab]')).map((element) =>
      element.getAttribute('data-select-tab'),
    );
    expect(keys).toEqual(['progress', 'sessions', 'logbook', 'climbs', 'social']);
  });

  it("renders ProfileClimbsTab with the signed-in user's own id once the Climbs tab is selected", () => {
    const { container } = render(<YouScreen />);

    // Not mounted before the tab is selected — progress is the default.
    expect(container.querySelector('[data-tab="climbs"]')).toBeNull();

    fireEvent.click(container.querySelector('[data-select-tab="climbs"]')!);

    expect(container.querySelector('[data-tab="climbs"]')).not.toBeNull();
    expect(rendered.climbs).toEqual([{ userId: 'user-own-123' }]);
  });

  it('composes one Logbook chrome and preserves the profile inset when switching back', () => {
    const { container } = render(<YouScreen />);
    act(() => ctrl.measureProfile?.(72));
    expect(rendered.progress.at(-1)?.topInset).toBe(72);

    fireEvent.click(container.querySelector('[data-select-tab="logbook"]')!);
    expect(container.querySelectorAll('[data-chrome]')).toHaveLength(1);
    const logbookChrome = container.querySelector('[data-chrome][data-active-tab="logbook"]')!;
    expect(logbookChrome.querySelector('[data-logbook-controls]')).not.toBeNull();

    act(() => ctrl.measureLogbook?.(240));
    expect(ctrl.logbookHeightChange).toHaveBeenLastCalledWith(240);
    fireEvent.click(logbookChrome.querySelector('[data-select-tab="progress"]')!);

    expect(container.querySelectorAll('[data-chrome]')).toHaveLength(1);
    expect(container.querySelector('[data-logbook-controls]')).toBeNull();
    expect(container.querySelector('[data-tab="logbook"]')).toBeNull();
    expect(rendered.progress.at(-1)?.topInset).toBe(72);
  });

  // The segmented control floats over the list on iOS 26. Logbook's header also
  // holds a bare text heading, search and sort chips, so it keeps its band.
  it('keeps the Logbook header opaque and lets every other sub-tab float', () => {
    const { container } = render(<YouScreen />);
    const opaqueControls = () => container.querySelector('[data-chrome]')?.getAttribute('data-opaque-controls');

    for (const floatingTab of ['progress', 'sessions', 'climbs', 'social']) {
      fireEvent.click(container.querySelector(`[data-select-tab="${floatingTab}"]`)!);
      expect(opaqueControls()).toBe('false');
    }
    fireEvent.click(container.querySelector('[data-select-tab="logbook"]')!);
    expect(opaqueControls()).toBe('true');
  });

  // The blur behind the floating segmented control shows only while the visible
  // sub-tab's list is scrolled under it.
  describe('under the UIKit header', () => {
    const scrollList = (tab: string, offsetY: number) =>
      act(() => ctrl.listScroll[tab]?.({ nativeEvent: { contentOffset: { x: 0, y: offsetY } } }));

    beforeEach(() => {
      ctrl.nativeRootHeader = true;
      ctrl.listTopOffset = -106;
    });

    it.each(['progress', 'sessions', 'climbs', 'social'])(
      'tells the header when the %s list scrolls under it and when it is back at rest',
      (tab) => {
        const { container } = render(<YouScreen />);
        fireEvent.click(container.querySelector(`[data-select-tab="${tab}"]`)!);
        const scrolledUnder = () => container.querySelector('[data-chrome]')?.getAttribute('data-scrolled-under');
        expect(scrolledUnder()).toBe('false');

        scrollList(tab, 240);
        expect(scrolledUnder()).toBe('true');

        // Pulled past the top (overscroll, pull-to-refresh), then settled.
        scrollList(tab, -160);
        expect(scrolledUnder()).toBe('false');
        scrollList(tab, -106);
        expect(scrolledUnder()).toBe('false');
      },
    );

    it('starts each sub-tab at rest, whatever the last one was scrolled to', () => {
      const { container } = render(<YouScreen />);
      const scrolledUnder = () => container.querySelector('[data-chrome]')?.getAttribute('data-scrolled-under');
      scrollList('progress', 600);
      expect(scrolledUnder()).toBe('true');

      fireEvent.click(container.querySelector('[data-select-tab="sessions"]')!);
      expect(scrolledUnder()).toBe('false');

      fireEvent.click(container.querySelector('[data-select-tab="progress"]')!);
      expect(scrolledUnder()).toBe('false');
    });
  });

  // Android, Material and the web keep opaque chrome: nothing floats over these
  // lists, so they are not given a scroll listener at all.
  it('leaves the lists without a scroll listener under the other chromes', () => {
    const { container } = render(<YouScreen />);

    for (const tab of ['progress', 'sessions', 'climbs', 'social']) {
      fireEvent.click(container.querySelector(`[data-select-tab="${tab}"]`)!);
      expect(tab in ctrl.listScroll).toBe(true);
      expect(ctrl.listScroll[tab]).toBeUndefined();
    }
  });
});
