import { createContext, useCallback, useContext, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { STORY_BOARD, STORY_CLIMBS } from '../../dev/fixtures/climbs';
import { StoryBoard } from '../../dev/stories/StoryBoard';
import type { StoryModule, StoryRenderControls } from '../../dev/stories/types';
import { useTheme } from '../../providers/theme-provider';
import { SheetTopBar } from '../SheetTopBar';
import { BoardCarouselView } from './BoardCarouselView';
import {
  BoardDiscoveryCardView,
  type BoardDiscoveryCardViewProps,
  type DiscoveryBoardItem,
} from './BoardDiscoveryCardView';
import { BoardSelectorSection, BoardSelectorView } from './BoardSelectorView';
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
];
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
function SelectorStory({ onReady, onError }: StoryRenderControls) {
  const { t } = useTranslation('boards');
  const { t: tCommon } = useTranslation('common');
  const { systemColors } = useTheme();
  const insets = useSafeAreaInsets();
  const displayed = useRef(new Set<string>());
  const onDisplayed = useCallback(
    (id: string) => {
      displayed.current.add(id);
      if (BOARDS.every((board) => displayed.current.has(board.key))) onReady();
    },
    [onReady],
  );
  const observer = useMemo(() => ({ onDisplayed, onError }), [onDisplayed, onError]);
  return (
    <ReadyContext value={observer}>
      <View style={{ flex: 1, paddingTop: insets.top, backgroundColor: systemColors.background }}>
        <SheetTopBar
          title={tCommon('mobile.nav.boards')}
          leading={{ kind: 'close', onPress: noop, accessibilityLabel: 'Close' }}
        />
        <BoardSelectorView
          scrollBottomPadding={insets.bottom + 24}
          onActiveBoardDetails={noop}
          showFirstBoardChoice={false}
          fromOnboarding={false}
          nearbySearch="idle"
          nearbyState="idle"
          onModeFindNearby={noop}
          onModeBluetooth={noop}
          onModeFindGym={noop}
          onModeCreate={noop}
          onModeAddWall={noop}
          hasBoards
          myBoardsSection={
            <BoardSelectorSection title={t('mobile.discovery.yourBoardsTitle')}>
              <BoardCarouselView Card={StoryCard} items={BOARDS} onSelect={noop} />
            </BoardSelectorSection>
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
      name: 'Followed boards and ways to find a wall',
      layout: 'fullscreen',
      readiness: 'explicit',
      render: (controls) => <SelectorStory {...controls} />,
    },
  },
};
export default stories;
