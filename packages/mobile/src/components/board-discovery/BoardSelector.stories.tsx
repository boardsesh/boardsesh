import { createContext, useCallback, useContext, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { STORY_BOARD, STORY_CLIMBS } from '../../dev/fixtures/climbs';
import { StoryBoard } from '../../dev/stories/StoryBoard';
import type { StoryModule, StoryRenderControls } from '../../dev/stories/types';
import { useTheme } from '../../providers/theme-provider';
import { SheetTopBar } from '../SheetTopBar';
import { AddBoardMenu } from './AddBoardMenu';
import type { BoardCardMenuCapabilities } from './board-card-menu';
import { BoardCarouselView } from './BoardCarouselView';
import {
  BoardDiscoveryCardView,
  type BoardDiscoveryCardViewProps,
  type DiscoveryBoardItem,
} from './BoardDiscoveryCardView';
import { BoardSelectorSection, BoardSelectorView } from './BoardSelectorView';
import type { PickerTopView } from './picker-top-view';
import { InRangeSection, type InRangeBoardArtProps } from './InRangeSection';
const noop = () => {};
const EMPTY_BOARD = { ...STORY_CLIMBS[0], frames: '' };
const ReadyContext = createContext<{ onDisplayed: (id: string) => void; onError: (error: unknown) => void }>({
  onDisplayed: noop,
  onError: noop,
});
const BOARDS: DiscoveryBoardItem[] = [
  {
    ...STORY_BOARD,
    key: 'garage',
    title: 'Garage Board',
    subtitle: 'Kilter · 40°',
    isActive: true,
    isViewerOwner: true,
    isPinned: true,
    offlineState: 'downloaded',
  },
  {
    ...STORY_BOARD,
    key: 'gym',
    title: 'Bergen Klatresenter Danmarksplass',
    subtitle: 'Kilter · 12 x 12',
    isViewerOwner: false,
    offlineState: 'downloading',
  },
  {
    ...STORY_BOARD,
    key: 'club',
    title: 'Club wall',
    subtitle: 'Kilter · 7 x 10',
    isViewerOwner: false,
    offlineState: 'off',
  },
];
const NEARBY_BOARDS: DiscoveryBoardItem[] = [
  { ...STORY_BOARD, key: 'nearby-close', title: 'Crux Kilter', subtitle: 'Kilter · 40°', distanceMeters: 2 },
  { ...STORY_BOARD, key: 'nearby-far', title: 'Boulder Box', subtitle: 'Kilter · 12 x 12', distanceMeters: 3240 },
];
// One Crux wall heard by a climber on a board somewhere else: the hero.
const IN_RANGE_HERO: DiscoveryBoardItem = {
  ...STORY_BOARD,
  key: 'crux-kilter',
  title: 'Crux Kilter Original',
  subtitle: 'Crux · 12 x 12',
};
// Crux's roster as At Crux lists it: A to Z, the subtitles without the gym,
// the board the climber is on (Crux Homewall) in place.
const AT_CRUX_ROWS: DiscoveryBoardItem[] = [
  { ...STORY_BOARD, key: 'crux-homewall', title: 'Crux Homewall', subtitle: '10 x 12', isActive: true },
  { ...IN_RANGE_HERO, subtitle: '12 x 12' },
  { ...STORY_BOARD, key: 'crux-training', title: 'Crux Training Wall', subtitle: '7 x 10' },
];
// Your boards while At Crux lists the board the climber is on: it shows once, up there.
const BOARDS_AWAY_FROM_GARAGE: DiscoveryBoardItem[] = BOARDS.map((board) => ({ ...board, isActive: false }));
const IN_RANGE_MOONBOARD = {
  kind: 'moonboard',
  key: 'moonboard:moonboard',
  boardType: 'moonboard',
  rssi: -55,
  deviceId: 'MOON-BOX',
} as const;
const AT_CRUX = { kind: 'at_gym', gymUuid: 'gym-crux', gymName: 'Crux', rows: AT_CRUX_ROWS } as const;
const IN_RANGE_STORY_STATES = {
  hero: {
    notice: null,
    content: { kind: 'hero', board: IN_RANGE_HERO },
    scanning: false,
    heardNothing: false,
  },
  // The scan heard Crux walls: the gym's whole roster, not only what it heard.
  atGym: { notice: null, content: { ...AT_CRUX, source: 'scan' }, scanning: false, heardNothing: false },
  // The scan still listening, the gym already known from the board the climber is on.
  atGymScanning: {
    notice: null,
    content: { ...AT_CRUX, source: 'active_board' },
    scanning: true,
    heardNothing: false,
  },
  // The scan switched off (`picker-auto-scan-kill`): the Scan card, and At Crux still.
  atGymScanOff: {
    notice: { kind: 'tap_to_scan' },
    content: { ...AT_CRUX, source: 'active_board' },
    scanning: false,
    heardNothing: false,
  },
  // Only a MoonBoard it can't name, and no gym known: its three ways forward.
  unnamed: {
    notice: null,
    content: { kind: 'unnamed', row: IN_RANGE_MOONBOARD },
    scanning: false,
    heardNothing: false,
  },
  permission: { notice: { kind: 'permission_card' }, content: { kind: 'none' }, scanning: false, heardNothing: false },
} satisfies Record<string, PickerTopView<DiscoveryBoardItem>>;
type InRangeStoryState = keyof typeof IN_RANGE_STORY_STATES;

/** The art each state draws, so the story is ready only once all of it painted. */
function inRangeArtKeys(state: InRangeStoryState | null): string[] {
  if (state === 'hero') return [`in-range:${IN_RANGE_HERO.key}`];
  if (state === 'atGym' || state === 'atGymScanning' || state === 'atGymScanOff') {
    return AT_CRUX_ROWS.map((item) => `in-range:${item.key}`);
  }
  return [];
}

/** Your boards as each state leaves it: without the board At Crux already lists. */
function yourBoardsFor(state: InRangeStoryState | null): DiscoveryBoardItem[] {
  return state === 'atGym' || state === 'atGymScanning' || state === 'atGymScanOff' ? BOARDS_AWAY_FROM_GARAGE : BOARDS;
}
const YOUR_BOARDS_MENU: BoardCardMenuCapabilities = {
  canPin: true,
  canDownload: true,
  canOpenDetails: true,
  canManage: true,
};
const NEARBY_MENU: BoardCardMenuCapabilities = {
  canPin: false,
  canDownload: false,
  canOpenDetails: true,
  canManage: false,
};
function StoryCard(props: Omit<BoardDiscoveryCardViewProps, 'boardImage'>) {
  const { onDisplayed, onError } = useContext(ReadyContext);
  const onReady = useCallback(() => onDisplayed(props.item.key), [props.item.key, onDisplayed]);
  return (
    <BoardDiscoveryCardView
      {...props}
      boardImage={
        <View style={{ width: '100%', height: '100%' }}>
          <StoryBoard climb={EMPTY_BOARD} onReady={onReady} onError={onError} />
        </View>
      }
    />
  );
}
function StoryInRangeArt({ item, size }: InRangeBoardArtProps) {
  const { onDisplayed, onError } = useContext(ReadyContext);
  const onReady = useCallback(() => onDisplayed(`in-range:${item.key}`), [item.key, onDisplayed]);
  return (
    <View style={{ width: size, height: size }}>
      <StoryBoard climb={EMPTY_BOARD} onReady={onReady} onError={onError} />
    </View>
  );
}
function SelectorStory({
  onReady,
  onError,
  inRangeState,
  withNearby,
}: StoryRenderControls & { inRangeState: InRangeStoryState | null; withNearby: boolean }) {
  const { t } = useTranslation('boards');
  const { t: tCommon } = useTranslation('common');
  const { systemColors } = useTheme();
  const insets = useSafeAreaInsets();
  const displayed = useRef(new Set<string>());
  const yourBoards = yourBoardsFor(inRangeState);
  const expectedKeys = useMemo(
    () => [
      ...yourBoardsFor(inRangeState).map((board) => board.key),
      ...(withNearby ? NEARBY_BOARDS.map((board) => board.key) : []),
      ...inRangeArtKeys(inRangeState),
    ],
    [inRangeState, withNearby],
  );
  const onDisplayed = useCallback(
    (id: string) => {
      displayed.current.add(id);
      if (expectedKeys.every((key) => displayed.current.has(key))) onReady();
    },
    [expectedKeys, onReady],
  );
  const observer = useMemo(() => ({ onDisplayed, onError }), [onDisplayed, onError]);
  return (
    <ReadyContext value={observer}>
      <View style={{ flex: 1, paddingTop: insets.top, backgroundColor: systemColors.background }}>
        <SheetTopBar
          title={tCommon('mobile.nav.boards')}
          leading={{ kind: 'close', onPress: noop, accessibilityLabel: 'Close' }}
          trailingAccessory={<AddBoardMenu onSelect={noop} />}
        />
        <BoardSelectorView
          scrollBottomPadding={insets.bottom + 24}
          onActiveBoardDetails={noop}
          showFirstBoardChoice={false}
          fromOnboarding={false}
          hasBoards
          onEmptySetUpBoard={noop}
          onEmptyAddSprayWall={noop}
          inRangeSection={
            inRangeState ? (
              <InRangeSection
                view={IN_RANGE_STORY_STATES[inRangeState]}
                BoardArt={StoryInRangeArt}
                onStart={noop}
                onOpenSettings={noop}
                onRetryLookup={noop}
                onPickBoard={noop}
                onUseMyLocation={noop}
                onSearchGyms={noop}
                onOwnBoard={noop}
              />
            ) : undefined
          }
          myBoardsSection={
            <BoardSelectorSection title={t('mobile.discovery.yourBoardsTitle')}>
              <BoardCarouselView
                Card={StoryCard}
                items={yourBoards}
                onSelect={noop}
                menuCapabilities={YOUR_BOARDS_MENU}
                onMenuAction={noop}
              />
            </BoardSelectorSection>
          }
          nearbySection={
            withNearby ? (
              <BoardSelectorSection title={t('mobile.discovery.nearbyTitle')}>
                <BoardCarouselView
                  Card={StoryCard}
                  items={NEARBY_BOARDS}
                  onSelect={noop}
                  menuCapabilities={NEARBY_MENU}
                  onMenuAction={noop}
                />
              </BoardSelectorSection>
            ) : undefined
          }
        />
      </View>
    </ReadyContext>
  );
}
const stories: StoryModule = {
  title: 'Boards / Selector',
  stories: {
    populated: {
      name: 'The board in front of you, your boards and boards near you',
      layout: 'fullscreen',
      readiness: 'explicit',
      render: (controls) => <SelectorStory {...controls} inRangeState="hero" withNearby />,
    },
    inRangeHero: {
      name: 'In range: one board the phone can name',
      layout: 'fullscreen',
      readiness: 'explicit',
      render: (controls) => <SelectorStory {...controls} inRangeState="hero" withNearby={false} />,
    },
    atGym: {
      name: 'At Crux: the gym the scan heard, its walls A to Z, the board you are on in place',
      layout: 'fullscreen',
      readiness: 'explicit',
      render: (controls) => <SelectorStory {...controls} inRangeState="atGym" withNearby={false} />,
    },
    atGymScanning: {
      name: 'At Crux while the scan still listens, the gym known from the board you are on',
      layout: 'fullscreen',
      readiness: 'explicit',
      render: (controls) => <SelectorStory {...controls} inRangeState="atGymScanning" withNearby={false} />,
    },
    atGymScanOff: {
      name: 'At Crux with the scan waiting for a tap',
      layout: 'fullscreen',
      readiness: 'explicit',
      render: (controls) => <SelectorStory {...controls} inRangeState="atGymScanOff" withNearby={false} />,
    },
    inRangeUnnamed: {
      name: 'In range: only a MoonBoard it cannot name, and no gym known',
      layout: 'fullscreen',
      readiness: 'explicit',
      render: (controls) => <SelectorStory {...controls} inRangeState="unnamed" withNearby={false} />,
    },
    inRangePermission: {
      name: 'In range: asking for Bluetooth first',
      layout: 'fullscreen',
      readiness: 'explicit',
      render: (controls) => <SelectorStory {...controls} inRangeState="permission" withNearby={false} />,
    },
  },
};
export default stories;
