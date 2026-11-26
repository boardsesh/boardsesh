// @vitest-environment jsdom
//
// "Whose board?" reports its picks. The friend-board action only reports a pick
// through the `onBound` it is handed, so a route that hands none sends no
// `Board Picker Selection Completed` at all. Reached from the picker (its +, or
// the Friends' boards "See all"), the pick completes the picker's opening under
// the picker's source; from Manage boards it counts an opening of its own.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import type { UserBoard } from '@boardsesh/shared-schema';
import type { FriendBoardActionOptions } from '../../../src/lib/boards/use-friend-board-action';

type Children = { children?: ReactNode };

const trackMock = vi.hoisted(() => vi.fn());
const friendAction = vi.hoisted(() => ({ options: null as null | FriendBoardActionOptions }));
const state = vi.hoisted(() => ({
  params: {} as Record<string, string | undefined>,
  entry: 'picker' as string,
  returnTo: '/(tabs)/climbs' as string | undefined,
  source: undefined as string | undefined,
}));

vi.mock('react-native', () => ({
  View: ({ children }: Children) => createElement('div', null, children),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles },
}));
vi.mock('@shopify/flash-list', () => ({ FlashList: () => null }));
vi.mock('expo-router', () => ({
  useRouter: () => ({ push: vi.fn() }),
  useLocalSearchParams: () => state.params,
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../../src/components/ActivityIndicator', () => ({ ActivityIndicator: () => null }));
vi.mock('../../../src/components/Avatar', () => ({ Avatar: () => null }));
vi.mock('../../../src/components/Button', () => ({ Button: () => null }));
vi.mock('../../../src/components/EmptyState', () => ({ EmptyState: () => null }));
vi.mock('../../../src/components/SearchField', () => ({ SearchField: () => null }));
vi.mock('../../../src/components/ShelfHeader', () => ({ SHELF_SECTION_GAP: 24 }));
vi.mock('../../../src/components/Text', () => ({ Text: () => null }));
vi.mock('../../../src/components/board-discovery/BoardRow', () => ({ BoardRow: () => null }));
vi.mock('../../../src/components/board-discovery/DiscoveryBoardArt', () => ({ DiscoveryBoardArt: () => null }));
vi.mock('../../../src/components/board-discovery/add-board-wizard/WizardStepHeader', () => ({
  WizardStepHeader: () => null,
}));
vi.mock('../../../src/components/gym-page/InsetGroupedCell', () => ({ InsetGroupedCell: () => null }));
vi.mock('../../../src/hooks/use-bottom-chrome-metrics', () => ({
  useBottomChromeMetrics: () => ({ scrollBottomPadding: 0 }),
}));
vi.mock('../../../src/hooks/use-current-user-id', () => ({
  useStoredUserId: () => ({ userId: 'viewer-1', isLoading: false }),
}));
vi.mock('../../../src/hooks/use-offline-query-state', () => ({
  useOfflineQueryState: () => ({ isBlocked: false }),
}));
vi.mock('../../../src/hooks/use-profile-share-options', () => ({
  useProfileShareOptions: () => ({ url: null }),
}));
vi.mock('../../../src/hooks/use-share-link-action', () => ({ useShareLinkAction: () => vi.fn() }));
vi.mock('../../../src/lib/boards/board-create-flow', () => ({ noteBoardFlowSecured: vi.fn() }));
vi.mock('../../../src/lib/boards/use-add-board-wizard-step', () => ({
  useAddBoardWizardStep: () => ({
    entry: state.entry,
    nextContext: { returnTo: state.returnTo, source: state.source, entry: state.entry, trail: ['where', 'friend'] },
    stepLabel: 'Step 2 of 2',
    markHandedOff: vi.fn(),
  }),
}));
vi.mock('../../../src/lib/boards/use-friend-board-action', () => ({
  useFriendBoardAction: (options: FriendBoardActionOptions) => {
    friendAction.options = options;
    return { onPress: vi.fn(), sheet: null };
  },
}));
vi.mock('../../../src/lib/graphql/hooks', () => ({
  useProfile: () => ({ data: { id: 'viewer-1', displayName: 'Viewer' }, isError: false, refetch: vi.fn() }),
}));
vi.mock('../../../src/lib/graphql/hooks/use-friends-boards', () => ({
  useFriendsBoards: () => ({
    data: { pages: [] },
    hasNextPage: false,
    isFetchingNextPage: false,
    fetchNextPage: vi.fn(),
    isPending: false,
    isError: false,
    refetch: vi.fn(),
    fetchStatus: 'idle',
  }),
}));
vi.mock('../../../src/lib/graphql/hooks/use-privacy', () => ({ usePrivacySettings: () => ({ data: undefined }) }));
vi.mock('../../../src/lib/graphql/use-active-board', () => ({
  useActiveBoard: () => ({ data: null, isError: false }),
}));
vi.mock('../../../src/lib/routing/open-sign-in', () => ({ openSignIn: vi.fn() }));
vi.mock('../../../src/providers/auth-provider', () => ({ useAuth: () => ({ isAuthenticated: true }) }));
vi.mock('../../../src/providers/theme-provider', () => ({
  useTheme: () => ({ systemColors: { secondaryLabel: '#999' } }),
}));
vi.mock('../../../src/theme/tokens', () => ({ spacing: { 2: 8, 3: 12, 4: 16, 8: 32 } }));
vi.mock('../../../src/lib/analytics', () => ({ track: trackMock }));

const { default: AddBoardFriend } = await import('../add/friend');

const board = { uuid: 'friend-wall', boardType: 'kilter', layoutId: 1, sizeId: 10, setIds: '1' } as UserBoard;

function events(name: string) {
  return trackMock.mock.calls.filter(([eventName]) => eventName === name).map(([, props]) => props);
}

async function pick() {
  const onBound = friendAction.options?.onBound;
  expect(onBound).toBeDefined();
  await onBound?.(board, { pickSource: 'friends', section: 'friend_step', position: 0, followed: true });
}

beforeEach(() => {
  vi.clearAllMocks();
  friendAction.options = null;
  state.params = {};
  state.entry = 'picker';
  state.returnTo = '/(tabs)/climbs';
  state.source = undefined;
});

describe('Whose board? pick event', () => {
  it("completes the picker's opening from the picker's +, under the picker's source", async () => {
    render(createElement(AddBoardFriend));
    expect(friendAction.options?.section).toBe('friend_step');
    await pick();
    expect(events('Board Picker Opened')).toEqual([]);
    expect(events('Board Picker Selection Completed')).toEqual([
      expect.objectContaining({
        source: 'board_picker',
        returnTo: '/(tabs)/climbs',
        pickSource: 'friends',
        section: 'friend_step',
        position: 0,
        followed: true,
      }),
    ]);
  });

  it('keeps the onboarding source the picker forwarded through "See all"', async () => {
    state.params = { shelf: '1' };
    state.source = 'onboarding';
    render(createElement(AddBoardFriend));
    await pick();
    expect(events('Board Picker Opened')).toEqual([]);
    expect(events('Board Picker Selection Completed')).toEqual([
      expect.objectContaining({ source: 'onboarding', section: 'friend_step' }),
    ]);
  });

  it('counts its own opening when Manage boards opened the wizard', async () => {
    state.entry = 'manage';
    render(createElement(AddBoardFriend));
    expect(events('Board Picker Opened')).toEqual([expect.objectContaining({ source: 'add_wizard' })]);
    await pick();
    expect(events('Board Picker Selection Completed')).toEqual([
      expect.objectContaining({ source: 'add_wizard', section: 'friend_step' }),
    ]);
  });
});
