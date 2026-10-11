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

import type { ScrollEdgeBackdrop } from '../../../../src/hooks/use-scroll-edge-backdrop';

const ctrl = vi.hoisted(() => ({
  profileId: 'user-own-123' as string | undefined,
  measureProfile: undefined as ((height: number) => void) | undefined,
  measureLogbook: undefined as ((height: number) => void) | undefined,
  logbookHeightChange: vi.fn(),
  // The scroll-edge store the mounted top chrome was handed, and the one each
  // mounted sub-tab's list was handed.
  chromeScrollEdge: undefined as ScrollEdgeBackdrop | undefined,
  listScrollEdge: {} as Record<string, ScrollEdgeBackdrop | undefined>,
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
    scrollEdge,
  }: {
    activeTab: string;
    onSelectTab: (key: string) => void;
    onHeightChange: (height: number) => void;
    children?: ReactNode;
    opaqueControls?: boolean;
    scrollEdge?: ScrollEdgeBackdrop;
  }) => {
    ctrl.chromeScrollEdge = scrollEdge;
    if (activeTab === 'logbook') ctrl.measureLogbook = onHeightChange;
    else ctrl.measureProfile = onHeightChange;
    return createElement(
      'div',
      { 'data-chrome': 'true', 'data-active-tab': activeTab, 'data-opaque-controls': String(opaqueControls === true) },
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
    scrollEdge,
  }: {
    userId: string | undefined;
    topInset: number;
    scrollEdge?: ScrollEdgeBackdrop;
  }) => {
    ctrl.listScrollEdge.progress = scrollEdge;
    rendered.progress.push({ userId, topInset });
    return createElement('div', { 'data-tab': 'progress' });
  },
}));
vi.mock('../../../../src/components/you/SessionsTab', () => ({
  SessionsTab: ({ userId, scrollEdge }: { userId: string | undefined; scrollEdge?: ScrollEdgeBackdrop }) => {
    ctrl.listScrollEdge.sessions = scrollEdge;
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
  ProfileClimbsTab: ({ userId, scrollEdge }: { userId: string | undefined; scrollEdge?: ScrollEdgeBackdrop }) => {
    ctrl.listScrollEdge.climbs = scrollEdge;
    rendered.climbs.push({ userId });
    return createElement('div', { 'data-tab': 'climbs' });
  },
}));
vi.mock('../../../../src/components/you/SocialTab', () => ({
  SocialTab: ({ userId, scrollEdge }: { userId: string | undefined; scrollEdge?: ScrollEdgeBackdrop }) => {
    ctrl.listScrollEdge.social = scrollEdge;
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
    ctrl.chromeScrollEdge = undefined;
    ctrl.listScrollEdge = {};
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
  // sub-tab's list is scrolled under it. The lists write that to a store the
  // screen holds, and the blur (inside the top chrome) reads it.
  describe('the scroll-edge store', () => {
    const SUB_TABS_WITH_FLOATING_HEADER = ['progress', 'sessions', 'climbs', 'social'];
    const selectTab = (container: HTMLElement, tab: string) =>
      fireEvent.click(container.querySelector(`[data-select-tab="${tab}"]`)!);
    const scrollEvent = (offsetY: number) =>
      ({ nativeEvent: { contentOffset: { x: 0, y: offsetY } } }) as Parameters<
        ScrollEdgeBackdrop['listProps']['onScroll']
      >[0];

    it('hands the floating chrome one store for the life of the screen', () => {
      const { container } = render(<YouScreen />);
      const store = ctrl.chromeScrollEdge;
      expect(store).toBeDefined();

      for (const tab of SUB_TABS_WITH_FLOATING_HEADER) {
        selectTab(container, tab);
        expect(ctrl.chromeScrollEdge).toBe(store);
      }
    });

    // Material, Android, the web, iOS before 26, Reduce Transparency: the header
    // is opaque, no blur mounts, and the lists carry no scroll listeners.
    it('gives the lists nothing until a blur is mounted to hear them', () => {
      const { container } = render(<YouScreen />);

      for (const tab of SUB_TABS_WITH_FLOATING_HEADER) {
        selectTab(container, tab);
        expect(tab in ctrl.listScrollEdge).toBe(true);
        expect(ctrl.listScrollEdge[tab]).toBeUndefined();
      }
    });

    it.each(SUB_TABS_WITH_FLOATING_HEADER)('wires the %s list to the store once a blur is listening', (tab) => {
      const { container } = render(<YouScreen />);
      act(() => {
        ctrl.chromeScrollEdge?.attachBackdrop();
      });

      selectTab(container, tab);

      expect(ctrl.listScrollEdge[tab]).toBe(ctrl.chromeScrollEdge);
    });

    // The screen holds the sub-tab and its list. Re-rendering it for each frame
    // of a scroll, or for each height a collapsing title reports, re-renders
    // every row with it.
    it('does not re-render the screen for a scroll, a flip, or the bar changing height', () => {
      render(<YouScreen />);
      const store = ctrl.chromeScrollEdge!;
      act(() => {
        store.attachBackdrop();
      });
      const rendersWired = rendered.progress.length;

      act(() => {
        for (const topOffset of [-158, -146, -120, -106]) store.setTopOffset(topOffset);
        for (const offsetY of [-106, 40, 600, -106, 900]) store.listProps.onScroll(scrollEvent(offsetY));
      });

      expect(store.isScrolledUnder()).toBe(true);
      expect(rendered.progress).toHaveLength(rendersWired);
    });

    // Logbook keeps its painted band, so nothing subscribes and nothing is wired.
    it('leaves the Logbook chrome out of it', () => {
      const { container } = render(<YouScreen />);
      selectTab(container, 'logbook');
      expect(ctrl.chromeScrollEdge).toBeUndefined();
    });
  });
});
