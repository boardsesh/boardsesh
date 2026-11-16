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
import type { InRangeView } from './in-range-view';
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
// The walls one phone hears at Crux, closest first.
const IN_RANGE_HERO: DiscoveryBoardItem = {
  ...STORY_BOARD,
  key: 'board:crux-kilter',
  title: 'Crux Kilter Original',
  subtitle: 'Crux · 12 x 12',
};
const IN_RANGE_ROWS: DiscoveryBoardItem[] = [
  IN_RANGE_HERO,
  { ...STORY_BOARD, key: 'board:crux-homewall', title: 'Crux Homewall', subtitle: 'Crux · 10 x 12' },
  { ...STORY_BOARD, key: 'board:crux-spray', title: 'Crux Training Wall', subtitle: 'Crux · 7 x 10' },
];
const IN_RANGE_MOONBOARD = {
  kind: 'moonboard',
  key: 'moonboard:moonboard',
  boardType: 'moonboard',
  rssi: -55,
  deviceId: 'MOON-BOX',
} as const;
const IN_RANGE_STORY_STATES = {
  hero: { content: { kind: 'hero', board: IN_RANGE_HERO, also: null }, scanning: false },
  // Three walls at Crux, with a MoonBoard it can't name heard behind them.
  gymRows: {
    content: {
      kind: 'board_rows',
      boards: IN_RANGE_ROWS,
      gymName: 'Crux',
      also: { kind: 'unnamed', row: IN_RANGE_MOONBOARD },
    },
    scanning: false,
  },
  // The MoonBoard is the strongest signal: it leads, the named Kilter follows.
  unnamed: {
    content: { kind: 'unnamed', row: IN_RANGE_MOONBOARD, boards: [IN_RANGE_HERO] },
    scanning: false,
  },
  permission: { content: { kind: 'permission_card' }, scanning: false },
} satisfies Record<string, InRangeView<DiscoveryBoardItem>>;
type InRangeStoryState = keyof typeof IN_RANGE_STORY_STATES;

/** The art each state draws, so the story is ready only once all of it painted. */
function inRangeArtKeys(state: InRangeStoryState | null): string[] {
  if (state === 'hero' || state === 'unnamed') return [`in-range:${IN_RANGE_HERO.key}`];
  if (state === 'gymRows') return IN_RANGE_ROWS.map((item) => `in-range:${item.key}`);
  return [];
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
  const expectedKeys = useMemo(
    () => [
      ...BOARDS.map((board) => board.key),
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
                items={BOARDS}
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
    inRangeGymRows: {
      name: 'In range: three walls at one gym, closest first, and a MoonBoard it cannot name',
      layout: 'fullscreen',
      readiness: 'explicit',
      render: (controls) => <SelectorStory {...controls} inRangeState="gymRows" withNearby={false} />,
    },
    inRangeUnnamed: {
      name: 'In range: a MoonBoard it cannot name leads, a named board follows',
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
