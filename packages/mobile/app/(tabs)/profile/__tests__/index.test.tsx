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

const ctrl = vi.hoisted(() => ({
  profileId: 'user-own-123' as string | undefined,
  measureProfile: undefined as ((height: number) => void) | undefined,
  measureLogbook: undefined as ((height: number) => void) | undefined,
  logbookHeightChange: vi.fn(),
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
  }: {
    activeTab: string;
    onSelectTab: (key: string) => void;
    onHeightChange: (height: number) => void;
    children?: ReactNode;
  }) => {
    if (activeTab === 'logbook') ctrl.measureLogbook = onHeightChange;
    else ctrl.measureProfile = onHeightChange;
    return createElement(
      'div',
      { 'data-chrome': 'true', 'data-active-tab': activeTab },
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
  ProgressTab: ({ userId, topInset }: { userId: string | undefined; topInset: number }) => {
    rendered.progress.push({ userId, topInset });
    return createElement('div', { 'data-tab': 'progress' });
  },
}));
vi.mock('../../../../src/components/you/SessionsTab', () => ({
  SessionsTab: ({ userId }: { userId: string | undefined }) => {
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
  ProfileClimbsTab: ({ userId }: { userId: string | undefined }) => {
    rendered.climbs.push({ userId });
    return createElement('div', { 'data-tab': 'climbs' });
  },
}));
vi.mock('../../../../src/components/you/SocialTab', () => ({
  SocialTab: ({ userId }: { userId: string | undefined }) => {
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
});
