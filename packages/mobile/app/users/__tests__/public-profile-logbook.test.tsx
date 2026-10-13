// @vitest-environment jsdom
//
// The Logbook saves its filters only on your own logbook, and reads that choice
// once at mount. On your own public profile `isSelf` turns true only after your
// profile loads, so the screen must remount the Logbook on that flip rather
// than hand a mounted one a new `viewerIsOwner`.
import { act, render } from '@testing-library/react';
import { createElement, useState, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const profileState = vi.hoisted(() => ({ currentUserId: undefined as string | undefined }));
const segment = vi.hoisted(() => ({ onSelect: null as null | ((key: string) => void) }));
const logbookTab = vi.hoisted(() => ({
  mounts: [] as boolean[],
  latestViewerIsOwner: undefined as boolean | undefined,
}));

vi.mock('react-native', () => ({
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles },
}));
vi.mock('expo-router', () => ({
  useLocalSearchParams: () => ({ userId: 'climber-1' }),
  useNavigation: () => ({ setOptions: vi.fn() }),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../../src/lib/graphql/hooks/use-privacy', () => ({ useProfilePrivacy: () => ({ data: undefined }) }));
vi.mock('../../../src/lib/graphql/hooks', () => ({
  useProfile: () => ({ data: profileState.currentUserId ? { id: profileState.currentUserId } : undefined }),
  usePublicProfile: () => ({
    data: { id: 'climber-1', displayName: 'Alex', canViewActivity: true },
    isPending: false,
    isError: false,
    status: 'success',
    fetchStatus: 'idle',
    refetch: vi.fn(),
  }),
  useYouProfileData: () => ({}),
}));
vi.mock('../../../src/hooks/use-offline-query-state', () => ({
  useOfflineQueryState: () => ({ isBlocked: false, reason: undefined }),
}));
vi.mock('../../../src/providers/theme-provider', () => ({
  useTheme: () => ({ systemColors: {}, brandColors: {} }),
}));
vi.mock('../../../src/theme/tokens', () => ({ spacing: {} }));
vi.mock('../../../src/components/Text', () => ({ Text: () => null }));
vi.mock('../../../src/components/Icon', () => ({ Icon: () => null }));
vi.mock('../../../src/components/ActivityIndicator', () => ({ ActivityIndicator: () => null }));
vi.mock('../../../src/components/Button', () => ({ Button: () => null }));
vi.mock('../../../src/components/OfflineState', () => ({ OfflineState: () => null }));
vi.mock('../../../src/components/SegmentedControl', () => ({
  SegmentedControl: ({ onSelect }: { onSelect: (key: string) => void }) => {
    segment.onSelect = onSelect;
    return null;
  },
}));
vi.mock('../../../src/components/you/PublicProfileHeaderBlock', () => ({ PublicProfileHeaderBlock: () => null }));
vi.mock('../../../src/components/you/ProgressTab', () => ({ ProgressTab: () => null }));
vi.mock('../../../src/components/you/SessionsTab', () => ({ SessionsTab: () => null }));
vi.mock('../../../src/components/you/ProfileClimbsTab', () => ({ ProfileClimbsTab: () => null }));
vi.mock('../../../src/components/you/LogbookTab', () => ({
  LogbookTab: ({ viewerIsOwner }: { viewerIsOwner: boolean }) => {
    logbookTab.latestViewerIsOwner = viewerIsOwner;
    // The initializer runs once per mount, so a prop change is not a mount.
    useState(() => logbookTab.mounts.push(viewerIsOwner));
    return null;
  },
}));

import PublicProfileScreen from '../[userId]/index';

beforeEach(() => {
  profileState.currentUserId = undefined;
  segment.onSelect = null;
  logbookTab.mounts = [];
  logbookTab.latestViewerIsOwner = undefined;
});

describe('PublicProfileScreen Logbook', () => {
  it('remounts the Logbook as your own once your profile loads', () => {
    const view = render(createElement(PublicProfileScreen));
    act(() => segment.onSelect?.('logbook'));
    expect(logbookTab.mounts).toEqual([false]);

    profileState.currentUserId = 'climber-1';
    view.rerender(createElement(PublicProfileScreen));
    expect(logbookTab.mounts).toEqual([false, true]);
    expect(logbookTab.latestViewerIsOwner).toBe(true);
  });

  it("keeps someone else's Logbook mounted as it is", () => {
    const view = render(createElement(PublicProfileScreen));
    act(() => segment.onSelect?.('logbook'));
    profileState.currentUserId = 'someone-else';
    view.rerender(createElement(PublicProfileScreen));
    expect(logbookTab.mounts).toEqual([false]);
    expect(logbookTab.latestViewerIsOwner).toBe(false);
  });
});
