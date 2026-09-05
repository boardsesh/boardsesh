// @vitest-environment jsdom
//
// Own-profile ("You" tab) parity regression guard for #3049: a "Climbs"
// (created-climbs) tab shipped on the public/other-user profile screen
// (app/users/[userId]/index.tsx) but was never wired into this own-profile
// screen, so a climber's own created climbs never appeared here even though
// they showed up fine when viewing someone else's profile. This test fails
// on a revert of that wiring.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

const ctrl = vi.hoisted(() => ({
  profileId: 'user-own-123' as string | undefined,
  accountFeatures: true,
}));

const graphql = vi.hoisted(() => ({
  useProfile: vi.fn(),
  useYouProfileData: vi.fn(),
}));

const rendered = vi.hoisted(() => ({
  progress: [] as Array<{ userId: string | undefined }>,
  sessions: [] as Array<{ userId: string | undefined }>,
  logbook: [] as Array<{ userId: string | undefined }>,
  climbs: [] as Array<{ userId: string | undefined }>,
  social: [] as Array<{ userId: string | undefined }>,
}));

vi.mock('react-native', () => ({
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles },
}));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock('expo-router', () => ({
  useLocalSearchParams: () => ({ screenshotTab: undefined }),
}));
vi.mock('../../../../src/lib/graphql/hooks', () => ({
  useProfile: graphql.useProfile,
  useYouProfileData: graphql.useYouProfileData,
}));
vi.mock('../../../../src/providers/auth-provider', () => ({
  useAuth: () => ({ accessCapabilities: { useAccountFeatures: ctrl.accountFeatures } }),
}));
vi.mock('../../../../src/components/you/LocalYouScreen', () => ({
  LocalYouScreen: () => createElement('div', { 'data-local-you': 'true' }),
}));
vi.mock('../../../../src/providers/theme-provider', () => ({
  useTheme: () => ({ systemColors: { background: '#fff' } }),
}));
// Stand-in top chrome: exposes one button per known tab key so the test can
// drive tab selection the same way a real tap would, without pulling in the
// real chrome's native segmented control / app bar machinery.
vi.mock('../../../../src/components/you/ProfileTopChrome', () => ({
  ProfileTopChrome: ({ activeTab, onSelectTab }: { activeTab: string; onSelectTab: (key: string) => void }) =>
    createElement(
      'div',
      { 'data-chrome': 'true', 'data-active-tab': activeTab },
      ['progress', 'sessions', 'logbook', 'climbs', 'social'].map((key) =>
        createElement('button', { key, 'data-select-tab': key, onClick: () => onSelectTab(key) }, key),
      ),
    ),
}));
vi.mock('../../../../src/components/you/YouFilterSheet', () => ({
  YouFilterSheet: () => createElement('div', { 'data-filter-sheet': 'true' }),
}));
vi.mock('../../../../src/components/you/ProgressTab', () => ({
  ProgressTab: ({ userId }: { userId: string | undefined }) => {
    rendered.progress.push({ userId });
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
  LogbookTab: ({ userId }: { userId: string | undefined }) => {
    rendered.logbook.push({ userId });
    return createElement('div', { 'data-tab': 'logbook' });
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
    ctrl.accountFeatures = true;
    graphql.useProfile.mockReset();
    graphql.useProfile.mockImplementation(() => ({ data: ctrl.profileId ? { id: ctrl.profileId } : undefined }));
    graphql.useYouProfileData.mockReset();
    graphql.useYouProfileData.mockReturnValue({
      hasActiveFilters: false,
      selectedBoard: 'all',
      setSelectedBoard: vi.fn(),
      timeframe: 'all',
      setTimeframe: vi.fn(),
    });
    rendered.progress = [];
    rendered.sessions = [];
    rendered.logbook = [];
    rendered.climbs = [];
    rendered.social = [];
  });

  it('renders the SQLite-only You surface without starting account profile queries', () => {
    ctrl.accountFeatures = false;
    const { container } = render(<YouScreen />);

    expect(container.querySelector('[data-local-you="true"]')).not.toBeNull();
    expect(graphql.useProfile).not.toHaveBeenCalled();
    expect(graphql.useYouProfileData).not.toHaveBeenCalled();
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
});
