import { createContext, useCallback, useContext, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { STORY_CLIMBS } from '../../dev/fixtures/climbs';
import { StoryBoard } from '../../dev/stories/StoryBoard';
import { useStoryArtReadiness } from '../../dev/stories/StoryPage';
import type { StoryModule, StoryRenderControls } from '../../dev/stories/types';
import type { BoardArtReadiness } from '../../lib/board-render/ready-board-art';
import type { LocationPermission } from '../../lib/use-device-location';
import { spacing } from '../../theme/tokens';
import { useTheme } from '../../providers/theme-provider';
import { BoardThumbnail } from '../boards/BoardThumbnail';
import { SheetTopBar } from '../SheetTopBar';
import { ShelfSection } from '../ShelfHeader';
import { AddBoardMenu } from './AddBoardMenu';
import type { BoardCardMenuCapabilities } from './board-card-menu';
import { BoardCarouselView } from './BoardCarouselView';
import {
  BoardDiscoveryCardView,
  type BoardDiscoveryCardViewProps,
  type DiscoveryBoardItem,
} from './BoardDiscoveryCardView';
import { BoardRowList } from './BoardRowList';
import { BoardSelectorView } from './BoardSelectorView';
import type { DiscoveryBoardArtProps } from './DiscoveryBoardArt';
import { FirstBoardChoice } from './FirstBoardChoice';
import { InRangeSection } from './InRangeSection';
import { LocationAskCard } from '../location/LocationAskCard';
import { NearbyQuietStatus } from './NearbyQuietStatus';
import { NearbyReservedSlot } from './NearbyReservedSlot';
import type { PickerTopView } from './picker-top-view';

const noop = () => {};
// The story's card answers like a climber who tapped and left it as it was.
const answerPermission = async (): Promise<LocationPermission> => 'ask';
const storyStyles = StyleSheet.create({
  locationAskGutter: { paddingHorizontal: spacing[4] },
});
const EMPTY_BOARD = { ...STORY_CLIMBS[0], frames: '' };
const ReadyContext = createContext<{ onDisplayed: (id: string) => void; onError: (error: unknown) => void }>({
  onDisplayed: noop,
  onError: noop,
});

type BoardConfig = Pick<DiscoveryBoardItem, 'boardName' | 'layoutId' | 'sizeId' | 'setIds'>;
const CONFIG = {
  original: { boardName: 'kilter', layoutId: 1, sizeId: 10, setIds: '1,20' },
  homewall10: { boardName: 'kilter', layoutId: 8, sizeId: 21, setIds: '26,27' },
  homewall7: { boardName: 'kilter', layoutId: 8, sizeId: 17, setIds: '26,27' },
  moon: { boardName: 'moonboard', layoutId: 3, sizeId: 1, setIds: '5,6,7,8,9,10' },
  tension: { boardName: 'tension', layoutId: 10, sizeId: 6, setIds: '12,13' },
  spray: { boardName: 'spray', layoutId: 990001, sizeId: 990001, setIds: '1' },
} satisfies Record<string, BoardConfig>;

const SPRAY_READY = { stage: 'ready' } as unknown as NonNullable<DiscoveryBoardItem['sprayImport']>;

// Crux's walls as At Crux lists them: A to Z, without the gym in the subtitle.
const CRUX_HOMEWALL: DiscoveryBoardItem = {
  ...CONFIG.homewall10,
  key: 'crux-homewall',
  title: 'Crux Homewall',
  subtitle: '10 x 10',
  isViewerOwner: false,
  offlineState: 'downloaded',
};
const CRUX_ORIGINAL: DiscoveryBoardItem = {
  ...CONFIG.original,
  key: 'crux-original',
  title: 'Crux Kilter Original',
  subtitle: '12 x 12',
};
const CRUX_MOON: DiscoveryBoardItem = {
  ...CONFIG.moon,
  key: 'crux-moon',
  title: 'Crux MoonBoard',
  subtitle: 'MoonBoard 2024 · 40°',
};
// The same wall in Your boards, where no heading names the gym: the subtitle leads with it.
const CRUX_HOMEWALL_YOURS: DiscoveryBoardItem = { ...CRUX_HOMEWALL, subtitle: 'Crux · 10 x 10' };
const CRUX_TRAINING: DiscoveryBoardItem = {
  ...CONFIG.homewall7,
  key: 'crux-training',
  title: 'Crux Training Wall',
  subtitle: '7 x 10',
};
const GARAGE: DiscoveryBoardItem = {
  ...CONFIG.homewall7,
  key: 'garage',
  title: 'Garage Board',
  subtitle: 'Kilter Homewall · 7 x 10',
  isViewerOwner: true,
  isPinned: true,
  offlineState: 'downloaded',
};
const BOULDERING_BAR: DiscoveryBoardItem = {
  ...CONFIG.moon,
  key: 'bouldering-bar',
  title: 'The Bouldering Bar',
  subtitle: 'MoonBoard 2024 · 40°',
  isViewerOwner: false,
};
const SHED_SPRAY: DiscoveryBoardItem = {
  ...CONFIG.spray,
  key: 'shed',
  title: 'Shed spray',
  subtitle: 'Spraywall',
  isViewerOwner: true,
  sprayImport: SPRAY_READY,
};
const NEARBY_BOARDS: DiscoveryBoardItem[] = [
  { ...CONFIG.original, key: 'boulder-box', title: 'Boulder Box', subtitle: 'Kilter · 12 x 12', distanceMeters: 3240 },
  {
    ...CONFIG.tension,
    key: 'bergen',
    title: 'Bergen Klatresenter Danmarksplass',
    subtitle: 'Tension 2 · 12 x 12',
    distanceMeters: 8400,
  },
];

const onIt = (item: DiscoveryBoardItem): DiscoveryBoardItem => ({ ...item, isActive: true });
const CRUX_ROSTER = [CRUX_HOMEWALL, CRUX_ORIGINAL, CRUX_MOON, CRUX_TRAINING];
const AT_CRUX_ON_HOMEWALL = [onIt(CRUX_HOMEWALL), CRUX_ORIGINAL, CRUX_MOON, CRUX_TRAINING];
// Crux Homewall is a board the climber follows: the one wall At Crux with a menu.
const CRUX_MENU_KEYS: ReadonlySet<string> = new Set([CRUX_HOMEWALL.key]);
const MOONBOARD_ROW = {
  kind: 'moonboard',
  key: 'moonboard:moonboard',
  boardType: 'moonboard',
  rssi: -55,
  deviceId: 'MOON-BOX',
} as const;

type SelectorState = {
  top: PickerTopView<DiscoveryBoardItem>;
  yourBoards: DiscoveryBoardItem[];
  nearby: 'results' | 'empty' | 'searching';
  /** Location permission: Near you above Your boards when granted (the default), the banner at the foot otherwise. */
  location?: 'granted' | 'ask' | 'blocked';
  firstRun?: boolean;
};

const QUIET_TOP = { notice: null, unnamed: null, scanning: false, heardNothing: false, loudestBoardKey: null } as const;
// Crux Homewall heard: a long At Crux keeps it in view.
const HEARD_AT_CRUX: ReadonlySet<string> = new Set([CRUX_HOMEWALL.key]);
const NOTHING_HEARD: ReadonlySet<string> = new Set();
const STATES = {
  atGym: {
    top: {
      ...QUIET_TOP,
      content: {
        kind: 'at_gym',
        gymUuid: 'gym-crux',
        gymName: 'Crux',
        source: 'scan',
        rows: AT_CRUX_ON_HOMEWALL,
        heardKeys: HEARD_AT_CRUX,
      },
    },
    yourBoards: [GARAGE, BOULDERING_BAR, SHED_SPRAY],
    nearby: 'results',
  },
  atGymScanning: {
    top: {
      ...QUIET_TOP,
      scanning: true,
      content: {
        kind: 'at_gym',
        gymUuid: 'gym-crux',
        gymName: 'Crux',
        source: 'active_board',
        rows: AT_CRUX_ON_HOMEWALL,
        heardKeys: NOTHING_HEARD,
      },
    },
    yourBoards: [GARAGE, BOULDERING_BAR, SHED_SPRAY],
    nearby: 'results',
  },
  // On the garage board, one Crux wall heard: Climb here, no At Crux under it.
  otherGymHero: {
    top: {
      ...QUIET_TOP,
      content: { kind: 'hero', board: { ...CRUX_ORIGINAL, subtitle: 'Crux · 12 x 12' }, strongestSignal: true },
    },
    yourBoards: [onIt(GARAGE), CRUX_HOMEWALL_YOURS, BOULDERING_BAR, SHED_SPRAY],
    nearby: 'results',
  },
  // At home on the garage board, nothing heard: Your boards leads.
  home: {
    top: { ...QUIET_TOP, heardNothing: true, content: { kind: 'none' } },
    yourBoards: [onIt(GARAGE), CRUX_HOMEWALL_YOURS, BOULDERING_BAR, SHED_SPRAY],
    nearby: 'results',
  },
  noActiveBoard: {
    top: {
      ...QUIET_TOP,
      content: {
        kind: 'at_gym',
        gymUuid: 'gym-crux',
        gymName: 'Crux',
        source: 'scan',
        rows: CRUX_ROSTER,
        heardKeys: HEARD_AT_CRUX,
      },
    },
    yourBoards: [GARAGE, BOULDERING_BAR, SHED_SPRAY],
    nearby: 'results',
  },
  unnamed: {
    top: { ...QUIET_TOP, unnamed: MOONBOARD_ROW, content: { kind: 'none' } },
    yourBoards: [onIt(GARAGE), CRUX_HOMEWALL_YOURS, BOULDERING_BAR, SHED_SPRAY],
    nearby: 'results',
  },
  // On Crux Homewall, a MoonBoard heard that the gym's list doesn't name: its card above At Crux.
  unnamedAtGym: {
    top: {
      ...QUIET_TOP,
      unnamed: MOONBOARD_ROW,
      content: {
        kind: 'at_gym',
        gymUuid: 'gym-crux',
        gymName: 'Crux',
        source: 'active_board',
        rows: AT_CRUX_ON_HOMEWALL,
        heardKeys: NOTHING_HEARD,
      },
    },
    yourBoards: [GARAGE, BOULDERING_BAR, SHED_SPRAY],
    nearby: 'results',
  },
  permission: {
    top: { ...QUIET_TOP, notice: { kind: 'permission_card' }, content: { kind: 'none' } },
    yourBoards: [onIt(GARAGE), CRUX_HOMEWALL_YOURS, BOULDERING_BAR, SHED_SPRAY],
    nearby: 'results',
  },
  // The search still out: placeholder cards hold Near you's space above Your boards.
  nearbySearching: {
    top: { ...QUIET_TOP, heardNothing: true, content: { kind: 'none' } },
    yourBoards: [onIt(GARAGE), CRUX_HOMEWALL_YOURS, BOULDERING_BAR, SHED_SPRAY],
    nearby: 'searching',
  },
  nearbyEmpty: {
    top: { ...QUIET_TOP, heardNothing: true, content: { kind: 'none' } },
    yourBoards: [onIt(GARAGE), CRUX_HOMEWALL_YOURS, BOULDERING_BAR, SHED_SPRAY],
    nearby: 'empty',
  },
  // At home, location never asked: no Near you, the banner at the foot asks.
  noLocation: {
    top: { ...QUIET_TOP, heardNothing: true, content: { kind: 'none' } },
    yourBoards: [onIt(GARAGE), CRUX_HOMEWALL_YOURS, BOULDERING_BAR, SHED_SPRAY],
    nearby: 'results',
    location: 'ask',
  },
  // Location refused for good: the banner sends the climber to Settings.
  locationDenied: {
    top: { ...QUIET_TOP, heardNothing: true, content: { kind: 'none' } },
    yourBoards: [onIt(GARAGE), CRUX_HOMEWALL_YOURS, BOULDERING_BAR, SHED_SPRAY],
    nearby: 'results',
    location: 'blocked',
  },
  firstRun: {
    top: { ...QUIET_TOP, notice: { kind: 'permission_card' }, content: { kind: 'none' } },
    yourBoards: [],
    nearby: 'empty',
    firstRun: true,
  },
} satisfies Record<string, SelectorState>;
type StateName = keyof typeof STATES;

/** The boards whose art a state paints, so the story is ready only once all of it has. */
function artKeys(state: SelectorState): string[] {
  const { content } = state.top;
  const topItems = content.kind === 'at_gym' ? content.rows : content.kind === 'hero' ? [content.board] : [];
  // A spray wall with no photo on disk draws the camera glyph, which never reports.
  const painted = [...topItems, ...state.yourBoards].filter((item) => item.boardName !== 'spray');
  return [
    ...painted.map((item) => `art:${item.key}`),
    ...(state.nearby === 'results' && !state.firstRun && (state.location ?? 'granted') === 'granted'
      ? NEARBY_BOARDS.map((item) => `card:${item.key}`)
      : []),
  ];
}

const YOUR_BOARDS_MENU: BoardCardMenuCapabilities = {
  canPin: true,
  canDownload: true,
  canOpenDetails: true,
  canManage: true,
  canReport: false,
};
const NEARBY_MENU: BoardCardMenuCapabilities = {
  canPin: false,
  canDownload: false,
  canOpenDetails: true,
  canManage: false,
  canReport: false,
};

/** The real thumbnail, reporting when its art has painted. */
function StoryBoardArt({ item, size }: DiscoveryBoardArtProps) {
  const { onDisplayed, onError } = useContext(ReadyContext);
  const board = useMemo(
    () => ({ boardType: item.boardName, layoutId: item.layoutId, sizeId: item.sizeId, setIds: item.setIds }),
    [item.boardName, item.layoutId, item.sizeId, item.setIds],
  );
  const onArtReadinessChange = useCallback(
    (readiness: BoardArtReadiness) => {
      if (readiness === 'ready') onDisplayed(`art:${item.key}`);
      if (readiness === 'failed') onError(new Error(`Board art failed for ${item.key}`));
    },
    [item.key, onDisplayed, onError],
  );
  return <BoardThumbnail board={board} size={size} onArtReadinessChange={onArtReadinessChange} />;
}

/** A Near you card with its own board's art: Bergen's Tension, not a Kilter. */
function StoryCard(props: Omit<BoardDiscoveryCardViewProps, 'boardImage'>) {
  const { onDisplayed, onError } = useContext(ReadyContext);
  const { item } = props;
  const onReady = useCallback(() => onDisplayed(`card:${item.key}`), [item.key, onDisplayed]);
  const board = useMemo(
    () => ({ boardName: item.boardName, layoutId: item.layoutId, sizeId: item.sizeId, setIds: item.setIds, angle: 40 }),
    [item.boardName, item.layoutId, item.sizeId, item.setIds],
  );
  return (
    <BoardDiscoveryCardView
      {...props}
      boardImage={
        <View style={{ width: '100%', height: '100%' }}>
          <StoryBoard climb={EMPTY_BOARD} board={board} onReady={onReady} onError={onError} />
        </View>
      }
    />
  );
}

function SelectorStory({ onReady, onError, stateName }: StoryRenderControls & { stateName: StateName }) {
  const state: SelectorState = STATES[stateName];
  const location = state.location ?? 'granted';
  const { t } = useTranslation('boards');
  const { t: tCommon } = useTranslation('common');
  const { systemColors } = useTheme();
  const insets = useSafeAreaInsets();
  const expectedKeys = useMemo(() => artKeys(state), [state]);
  const onDisplayed = useStoryArtReadiness(expectedKeys, onReady);
  const observer = useMemo(() => ({ onDisplayed, onError }), [onDisplayed, onError]);
  const mapAction = { label: t('mobile.discovery.nearbyMap'), onPress: noop };
  const nearbySection = (
    <ShelfSection title={t('mobile.discovery.nearbyTitle')} action={state.firstRun ? undefined : mapAction}>
      {state.nearby === 'results' ? (
        <BoardCarouselView
          Card={StoryCard}
          items={NEARBY_BOARDS}
          onSelect={noop}
          menuCapabilities={NEARBY_MENU}
          onMenuAction={noop}
        />
      ) : state.nearby === 'searching' ? (
        <NearbyReservedSlot searching quiet>
          {null}
        </NearbyReservedSlot>
      ) : (
        <NearbyQuietStatus
          state="none_nearby"
          allShownAbove={false}
          onRetryNearby={noop}
          onOpenSettings={noop}
          onFindGymOnMap={noop}
        />
      )}
    </ShelfSection>
  );
  return (
    <ReadyContext value={observer}>
      <View style={{ flex: 1, paddingTop: insets.top, backgroundColor: systemColors.background }}>
        <SheetTopBar
          title={tCommon('mobile.nav.boards')}
          leading={{ kind: 'close', onPress: noop, accessibilityLabel: 'Close' }}
          trailingAccessory={state.firstRun ? undefined : <AddBoardMenu onSelect={noop} />}
        />
        <BoardSelectorView
          scrollBottomPadding={insets.bottom + 24}
          onActiveBoardDetails={noop}
          showFirstBoardChoice={state.firstRun === true}
          fromOnboarding={false}
          hasBoards={state.yourBoards.length > 0}
          onEmptySetUpBoard={noop}
          onEmptyAddSprayWall={noop}
          inRangeSection={
            <InRangeSection
              view={state.top}
              BoardArt={StoryBoardArt}
              onStart={noop}
              onOpenSettings={noop}
              bluetoothOffFix="control_center"
              onTurnOnBluetooth={noop}
              onBluetoothNotNow={noop}
              onRetryLookup={noop}
              onPickBoard={noop}
              onUseMyLocation={noop}
              onSearchGyms={noop}
              onOwnBoard={noop}
              atGymMenuCapabilities={YOUR_BOARDS_MENU}
              onAtGymMenuAction={noop}
              atGymMenuKeys={CRUX_MENU_KEYS}
            />
          }
          myBoardsSection={
            state.yourBoards.length > 0 ? (
              <ShelfSection
                title={t('mobile.discovery.yourBoardsTitle')}
                action={{ label: t('mobile.discovery.manage'), onPress: noop }}
              >
                <BoardRowList
                  items={state.yourBoards}
                  onSelect={noop}
                  menuCapabilities={YOUR_BOARDS_MENU}
                  onMenuAction={noop}
                  BoardArt={StoryBoardArt}
                />
              </ShelfSection>
            ) : undefined
          }
          nearbySection={location === 'granted' ? nearbySection : undefined}
          locationBanner={
            location === 'granted' ? undefined : (
              <LocationAskCard
                surface="board_picker"
                permission={location}
                onAllow={answerPermission}
                onRecheck={answerPermission}
                style={storyStyles.locationAskGutter}
              />
            )
          }
          firstBoardChoice={
            <FirstBoardChoice
              gymState="idle"
              nearbyResults={null}
              onGym={noop}
              onOwn={noop}
              onAddSprayWall={noop}
              onFindGymOnMap={noop}
              onOpenSettings={noop}
              onRetryNearby={noop}
            />
          }
        />
      </View>
    </ReadyContext>
  );
}

function selectorStory(name: string, stateName: StateName) {
  return {
    name,
    layout: 'fullscreen' as const,
    // A state with no board art (first run) has nothing to report: it is ready once laid out.
    readiness: artKeys(STATES[stateName]).length > 0 ? ('explicit' as const) : ('layout' as const),
    render: (controls: StoryRenderControls) => <SelectorStory {...controls} stateName={stateName} />,
  };
}

const stories: StoryModule = {
  title: 'Boards / Selector',
  stories: {
    // `board-selector--populated` is the screenshot harness's board-sheet shot: the picker at a gym.
    populated: selectorStory('At Crux on Crux Homewall: the gym A to Z, your boards, boards near you', 'atGym'),
    atGymScanning: selectorStory(
      'At Crux while the scan still listens, the gym known from your board',
      'atGymScanning',
    ),
    otherGymHero: selectorStory('On your garage board, one Crux wall heard: Climb here', 'otherGymHero'),
    home: selectorStory('At home on your garage board, nothing heard: your boards lead', 'home'),
    noActiveBoard: selectorStory('No board picked yet, at Crux', 'noActiveBoard'),
    unnamed: selectorStory('Only a MoonBoard it cannot name, and no gym known', 'unnamed'),
    unnamedAtGym: selectorStory('A MoonBoard it cannot name, above At Crux', 'unnamedAtGym'),
    permission: selectorStory('Asking for Bluetooth first', 'permission'),
    nearbySearching: selectorStory('Near you searching: placeholder cards above Your boards', 'nearbySearching'),
    nearbyEmpty: selectorStory('Nothing within 20 km: Near you keeps its Map', 'nearbyEmpty'),
    noLocation: selectorStory('Location never asked: Allow location at the foot, no Near you', 'noLocation'),
    locationDenied: selectorStory('Location refused: Open Settings at the foot, no Near you', 'locationDenied'),
    firstRun: selectorStory('First run: asking for Bluetooth, then where you climb', 'firstRun'),
  },
};
export default stories;
