// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import type { Climb } from '@boardsesh/queue';

// Parity guard for the smart-playlist detail screen: it must opt into whole-queue
// replacement (replaceQueueOnActivate) and thread the queue-replace sheet through,
// exactly like the regular playlist detail screen. The hook + sheet themselves are
// unit-tested elsewhere; here we only assert the wiring.
type CapturedOptions = { sourceId: string; replaceQueueOnActivate?: boolean; previewOnly?: boolean };

const smartMocks = vi.hoisted(() => ({
  activationOptions: null as CapturedOptions | null,
  activate: vi.fn<(climb: Climb) => Promise<void>>(),
  queueReplaceSheet: {
    visible: true,
    futureQueueCount: 2,
    isReplacing: false,
    onCancel: vi.fn(),
    onConfirm: vi.fn(),
  },
  allClimbs: [{ uuid: 'c-1', name: 'Boulder' }] as unknown as Climb[],
}));

vi.mock('expo-router', () => ({ useLocalSearchParams: () => ({ type: 'liked' }) }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

vi.mock('@boardsesh/playlists-react', () => ({
  useSmartPlaylist: () => ({
    query: { isLoading: false, isFetchingNextPage: false, hasNextPage: false, fetchNextPage: vi.fn() },
    allClimbs: smartMocks.allClimbs,
    meta: { climbCount: 1, userName: 'Tester' },
  }),
}));

vi.mock('@boardsesh/graphql/operations/playlists', () => ({ GET_SMART_PLAYLIST: 'GET_SMART_PLAYLIST' }));

vi.mock('react-native', () => ({
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles },
}));

vi.mock('../../../../../src/components/Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));
vi.mock('../../../../../src/components/Icon', () => ({ Icon: () => null }));
vi.mock('../../../../../src/components/ClimbListRowSkeleton', () => ({ ClimbListRowSkeleton: () => null }));

type DetailViewProps = { onActivateClimb?: (climb: Climb) => void };
type SheetProps = { visible?: boolean; futureQueueCount?: number };
vi.mock('../../../../../src/components/playlist', () => ({
  SKELETON_PLACEHOLDERS: [],
  PlaylistBackFab: () => null,
  PlaylistDetailView: ({ onActivateClimb }: DetailViewProps) =>
    createElement('button', {
      'data-activate': 'true',
      onClick: () => onActivateClimb?.({ uuid: 'c-1' } as unknown as Climb),
    }),
  PlaylistQueueReplaceSheet: ({ visible, futureQueueCount }: SheetProps) =>
    createElement('div', { 'data-sheet': visible ? 'true' : 'false', 'data-future-count': String(futureQueueCount) }),
}));

vi.mock('../../../../../src/lib/graphql/client', () => ({ getHttpClient: () => ({ request: vi.fn() }) }));
vi.mock('../../../../../src/lib/playlists/use-playlist-activation', () => ({
  usePlaylistActivation: (options: CapturedOptions) => {
    smartMocks.activationOptions = options;
    return { activate: smartMocks.activate, queueReplaceSheet: smartMocks.queueReplaceSheet };
  },
}));
vi.mock('../../../../../src/lib/playlists/use-playlist-render-board', () => ({
  usePlaylistRenderBoard: () => ({ renderBoard: null }),
}));
vi.mock('../../../../../src/lib/climb-types', () => ({ toQueueClimbs: (climbs: unknown) => climbs }));
vi.mock('../../../../../src/lib/smart-playlists', () => ({
  smartPlaylistByType: () => ({
    type: 'LIKED_CLIMBS',
    titleI18nKey: 'library.smart.likedClimbs.title',
    color: '#f00',
    icon: 'favorite',
  }),
}));
vi.mock('../../../../../src/lib/graphql/hooks', () => ({ useProfile: () => ({ data: { id: 'u-1' } }) }));
vi.mock('../../../../../src/lib/graphql/use-auth-token', () => ({ useAuthToken: () => ({ isLoading: false }) }));
vi.mock('../../../../../src/theme/ios-colors', () => ({ iosSystemColors: { systemGray4: '#C7C7CC' } }));
// Whether anyone else is in the session — what decides between replacing the
// crew's queue and simply showing the tapped climb.
const sessionMock = vi.hoisted(() => ({ isShared: false }));
vi.mock('../../../../../src/providers/queue-provider', () => ({
  useIsSharedSession: () => sessionMock.isShared,
}));

import SmartPlaylistDetail from '../[type]';

describe('SmartPlaylistDetail queue replacement wiring', () => {
  it('activates with replaceQueueOnActivate and renders the queue-replace sheet', () => {
    const { container } = render(<SmartPlaylistDetail />);

    expect(smartMocks.activationOptions?.replaceQueueOnActivate).toBe(true);
    expect(smartMocks.activationOptions?.sourceId).toBe('smart:LIKED_CLIMBS:u-1');

    const sheet = container.querySelector('[data-sheet]');
    expect(sheet?.getAttribute('data-sheet')).toBe('true');
    expect(sheet?.getAttribute('data-future-count')).toBe('2');

    fireEvent.click(container.querySelector('[data-activate]')!);
    expect(smartMocks.activate).toHaveBeenCalledWith({ uuid: 'c-1' });
  });

  // Same rule as the playlist detail screen: with a crew present, a row tap is a
  // look — not a replacement of everyone's queue plus a wall grab.
  it('browses a row tap in a crew instead of replacing everyone’s queue', () => {
    sessionMock.isShared = true;
    render(<SmartPlaylistDetail />);

    expect(smartMocks.activationOptions?.previewOnly).toBe(true);
  });

  it('leaves a solo row tap replacing the queue as before', () => {
    sessionMock.isShared = false;
    render(<SmartPlaylistDetail />);

    expect(smartMocks.activationOptions?.previewOnly).toBe(false);
    expect(smartMocks.activationOptions?.replaceQueueOnActivate).toBe(true);
  });
});
