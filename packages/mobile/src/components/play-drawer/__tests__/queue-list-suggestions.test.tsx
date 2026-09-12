// @vitest-environment jsdom
import { render, fireEvent } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Climb, ClimbQueueItem, PlaylistSuggestionSource } from '@boardsesh/queue';

// Issue #5403: the queue sheet's suggestion rows mix two provenances — a short
// playlist topped up with the board's own popular-by-ascents feed — and that mix
// is fine for DISPLAY. It stopped being fine for NAVIGATION: a tap used to mint
// one track spanning both segments, so swiping off a filtered playlist walked
// silently into feed climbs the climber had filtered out. `handleSuggestionPress`
// now picks the track from whichever segment the tapped climb actually came
// from. This file renders the real QueueList and taps real rows, so a future
// change that quietly re-merges the two segments at the call site (rather than
// only in the row list) fails here even though the pure track-building helpers
// stay green.

type ViewProps = { children?: ReactNode; testID?: string; style?: unknown };

// Mutable per-test: the board-scoped feed `useBoardContinuationFeed` hands back.
const feedFixture = vi.hoisted(() => ({ climbs: [] as Climb[] }));

vi.mock('react-native', () => ({
  View: ({ children }: ViewProps) => createElement('div', null, children),
  Pressable: ({
    children,
    onPress,
    accessibilityLabel,
  }: ViewProps & { onPress?: () => void; accessibilityLabel?: string }) =>
    createElement('button', { onClick: onPress, 'aria-label': accessibilityLabel }, children),
  Platform: { OS: 'ios', select: (options: Record<string, unknown>) => options.ios ?? options.default },
  StyleSheet: { create: (styles: Record<string, unknown>) => styles, hairlineWidth: 1 },
}));

vi.mock('@expo/ui/community/bottom-sheet', () => ({
  BottomSheetFlatList: ({
    data,
    renderItem,
    keyExtractor,
  }: {
    data: unknown[];
    renderItem: (info: { item: unknown; index: number }) => ReactNode;
    keyExtractor: (item: unknown, index: number) => string;
  }) =>
    createElement(
      'div',
      null,
      data.map((item, index) => createElement('div', { key: keyExtractor(item, index) }, renderItem({ item, index }))),
    ),
}));

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({
    systemColors: { separator: '#ccc', secondaryBackground: '#fff' },
    brandColors: { primary: '#6D28D9' },
  }),
}));

vi.mock('../../../lib/haptics', () => ({ hapticSelection: vi.fn() }));
vi.mock('../../../theme/tokens', () => ({
  spacing: { 1: 4, 2: 8, 3: 12, 4: 16, 10: 40, 16: 64 },
}));
vi.mock('../../../theme/ios-colors', () => ({ iosSystemColors: { systemGray: '#888' } }));
vi.mock('../../sheet-content-inset', () => ({ withSheetBottomInset: (style: unknown) => style }));
vi.mock('../use-queue-drag', () => ({
  useQueueDrag: () => ({
    isDragging: false,
    controls: { shared: {}, onRowHeight: vi.fn(), makeHandleGesture: vi.fn() },
  }),
}));
vi.mock('../../Text', () => ({ Text: ({ children }: ViewProps) => createElement('span', null, children) }));
vi.mock('../../ClimbListItemContent', () => ({ ClimbListItemContent: () => createElement('span', null) }));
vi.mock('../../QueueItemRow', () => ({
  POSITION_SLOT_WIDTH: 28,
  SEPARATOR_INSET: 200,
  QueueItemRow: () => createElement('div'),
}));

// The board-scoped popular feed. Mocked directly (rather than the underlying
// `useSearchClimbs`) so each case controls exactly which climbs come back as
// FEED-provenance without touching GraphQL plumbing.
vi.mock('../../../providers/queue/use-board-continuation-feed', () => ({
  useBoardContinuationFeed: () => ({ climbs: feedFixture.climbs, isSettled: true }),
}));

vi.mock('../../../providers/queue-provider', () => ({
  useQueueSessionId: () => ({ sessionId: null }),
}));
vi.mock('../../../providers/party-profile-provider', () => ({
  usePartyProfile: () => ({ profile: null, isLoading: false }),
}));

import { QueueList } from '../QueueList';

const board = { boardName: 'kilter' as const, layoutId: 1, sizeId: 10, setIds: '1,2', angle: 40 };

function climb(uuid: string): Climb {
  return { uuid, name: `Climb ${uuid}` } as Climb;
}

function renderList(
  playlistSuggestionSource: PlaylistSuggestionSource | null,
  onSuggestionPress: (climb: Climb, source: PlaylistSuggestionSource) => void,
) {
  return render(
    createElement(QueueList, {
      queue: [] as ClimbQueueItem[],
      currentItemUuid: null,
      board,
      isEditMode: false,
      showHistory: true,
      showFullHistory: true,
      selectedItems: new Set<string>(),
      playlistSuggestionSource,
      active: true,
      onToggleSelect: vi.fn(),
      onClimbPress: vi.fn(),
      onRemove: vi.fn(),
      onShowFullHistory: vi.fn(),
      onTickHistory: vi.fn(),
      onSuggestionPress,
      reorderQueue: vi.fn(),
    }),
  );
}

describe('QueueList suggestion row provenance (#5403)', () => {
  beforeEach(() => {
    feedFixture.climbs = [];
  });

  it('re-anchors the playlist track on a playlist-derived row, with no feed climb along for the ride', () => {
    const activatedClimb = climb('activated');
    const playlistFollow = climb('playlist-follow');
    const source: PlaylistSuggestionSource = {
      playlistUuid: 'climblist',
      activatedClimbUuid: activatedClimb.uuid,
      boardKey: 'kilter:1:10:1,2',
      climbs: [activatedClimb, playlistFollow],
    };
    const feedClimb = climb('feed-only');
    feedFixture.climbs = [feedClimb];
    const onSuggestionPress = vi.fn<(climb: Climb, source: PlaylistSuggestionSource) => void>();

    const { getByLabelText } = renderList(source, onSuggestionPress);
    fireEvent.click(getByLabelText(playlistFollow.name));

    expect(onSuggestionPress).toHaveBeenCalledTimes(1);
    const [pressedClimb, resultSource] = onSuggestionPress.mock.calls[0] as [Climb, PlaylistSuggestionSource];
    expect(pressedClimb.uuid).toBe(playlistFollow.uuid);
    const resultUuids = resultSource.climbs.map((c) => c.uuid);
    expect(resultUuids).toContain(playlistFollow.uuid);
    expect(resultUuids).not.toContain(feedClimb.uuid);
    // Re-anchored, not a fresh source: the playlist's own identity survives.
    expect(resultSource.playlistUuid).toBe('climblist');
    expect(resultSource.activatedClimbUuid).toBe(playlistFollow.uuid);
  });

  it('mints a feed-only track on a feed-derived row, with no playlist climb along for the ride', () => {
    const activatedClimb = climb('activated');
    const playlistFollow = climb('playlist-follow');
    const source: PlaylistSuggestionSource = {
      playlistUuid: 'climblist',
      activatedClimbUuid: activatedClimb.uuid,
      boardKey: 'kilter:1:10:1,2',
      climbs: [activatedClimb, playlistFollow],
    };
    const feedClimbA = climb('feed-a');
    const feedClimbB = climb('feed-b');
    feedFixture.climbs = [feedClimbA, feedClimbB];
    const onSuggestionPress = vi.fn<(climb: Climb, source: PlaylistSuggestionSource) => void>();

    const { getByLabelText } = renderList(source, onSuggestionPress);
    fireEvent.click(getByLabelText(feedClimbA.name));

    expect(onSuggestionPress).toHaveBeenCalledTimes(1);
    const [pressedClimb, resultSource] = onSuggestionPress.mock.calls[0] as [Climb, PlaylistSuggestionSource];
    expect(pressedClimb.uuid).toBe(feedClimbA.uuid);
    const resultUuids = resultSource.climbs.map((c) => c.uuid);
    expect(resultUuids).toEqual(expect.arrayContaining([feedClimbA.uuid, feedClimbB.uuid]));
    expect(resultUuids).not.toContain(playlistFollow.uuid);
    expect(resultUuids).not.toContain(activatedClimb.uuid);
    expect(resultSource.playlistUuid).not.toBe('climblist');
  });
});
