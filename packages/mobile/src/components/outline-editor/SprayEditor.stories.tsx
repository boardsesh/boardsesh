import { useCallback, useEffect, useMemo, useState } from 'react';
import { View, type LayoutChangeEvent } from 'react-native';
import { Stack } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useSharedValue } from 'react-native-reanimated';
import type { StoryModule, StoryRenderControls } from '../../dev/stories/types';
import { useStoryBoardFixture } from '../../dev/stories/story-board-fixture';
import { STORY_BOARDS } from '../../dev/fixtures/boards';
import { sprayStoryPhoto } from '../../dev/stories/StorySprayBoard';
import { InteractiveFilterBoard, type FilterBoardTransformContext } from '../search/InteractiveFilterBoard';
import { SprayEditorView, SprayEditorPhoneChromeView } from './SprayEditorView';
import { SprayHoldSvgLayer } from './SprayHoldSvgLayer';
import { SprayEditorBottomBar } from './SprayEditorBottomBar';
import { SprayCountCapsule, SprayEditorMenu } from './SprayCountCapsule';
import { SprayEditorHeaderActions } from './SprayEditorHeaderActions';
import { SprayTabletChrome } from './SprayTabletChrome';
import { SprayToolRail } from './SprayToolRail';
import { useSprayEditorLayout, sprayPhotoReservesBottom } from './use-spray-editor-layout';
import { fitSprayPhoto } from './spray-photo-frame';
import type { SprayEditorMode } from './spray-editor-mode';
import type { SprayRailSide } from './spray-tablet-layout';
import { countEditorHolds, type SprayEditorHold } from './spray-hold-editor-reducer';
const noop = () => {};
const noHolds: never[] = [];
const noCommands: never[] = [];
function SprayEditorStory({ onReady, onError }: StoryRenderControls) {
  const activeFixture = useStoryBoardFixture();
  const fixture = activeFixture.spray ? activeFixture : STORY_BOARDS['spray-liz'];
  const geometry = fixture.spray!;
  const fixtureHolds = useMemo(
    () =>
      geometry.holds.map(
        (hold) =>
          ({
            ...hold,
            source: 'AUTO',
            confidence: 1,
            review: 'accepted',
            dirty: false,
          }) satisfies SprayEditorHold,
      ),
    [geometry],
  );
  const counts = countEditorHolds(Object.fromEntries(fixtureHolds.map((hold) => [hold.id, hold])), 0);

  const { t } = useTranslation('boards');
  const insets = useSafeAreaInsets();
  const [area, setArea] = useState({ width: 0, height: 0 });
  const [photo, setPhoto] = useState<string | null>(null);
  const [mode, setMode] = useState<SprayEditorMode>('select');
  const [railSide, setRailSide] = useState<SprayRailSide>('leading');
  const [menuOpen, setMenuOpen] = useState(false);
  const { layout, landscape } = useSprayEditorLayout(area);
  const tablet = layout === 'tablet';
  const maybeOpacitySV = useSharedValue(1);
  const draftPointsSV = useSharedValue<number[]>([]);
  useEffect(() => {
    let cancelled = false;
    const asset = sprayStoryPhoto(geometry.photoId);
    void asset.downloadAsync().then(() => {
      if (!cancelled) setPhoto(asset.localUri ?? asset.uri);
    }, onError);
    return () => {
      cancelled = true;
    };
  }, [onError, geometry]);
  const onLayout = useCallback(
    ({ nativeEvent: { layout: bounds } }: LayoutChangeEvent) =>
      setArea((previous) =>
        previous.width === bounds.width && previous.height === bounds.height
          ? previous
          : { width: bounds.width, height: bounds.height },
      ),
    [],
  );
  const frame = fitSprayPhoto({
    areaWidth: area.width,
    areaHeight: area.height,
    bottomInset: insets.bottom,
    photoWidth: geometry.width,
    photoHeight: geometry.height,
    reserveBottom: sprayPhotoReservesBottom(layout),
  });
  const viewport = useMemo(
    () => ({
      width: area.width,
      height: Math.max(area.height, frame.slotHeight),
      offsetX: (area.width - frame.width) / 2,
      offsetY: (frame.slotHeight - frame.height) / 2,
      bandStartX: 0,
      bandEndX: area.width,
      bandStartY: 0,
      bandEndY: frame.slotHeight,
    }),
    [area.width, area.height, frame.width, frame.height, frame.slotHeight],
  );
  const renderInTransform = useCallback(
    ({ scaleSV, renderWidth, renderHeight }: FilterBoardTransformContext) => (
      <SprayHoldSvgLayer
        holds={fixtureHolds}
        showMaybes
        selectedId={null}
        maybeOpacitySV={maybeOpacitySV}
        draftPointsSV={draftPointsSV}
        scaleSV={scaleSV}
        boardWidth={geometry.width}
        boardHeight={geometry.height}
        renderWidth={renderWidth}
        renderHeight={renderHeight}
      />
    ),
    [maybeOpacitySV, draftPointsSV, fixtureHolds, geometry],
  );
  const onArtReadinessChange = useCallback(
    (status: 'ready' | 'loading' | 'failed') => {
      if (status === 'ready') onReady();
      if (status === 'failed') onError(new Error('Spray editor photo failed to display'));
    },
    [onReady, onError],
  );
  const primaryLabel = t('sprayMaintenance.publish');
  const toggleMenu = () => setMenuOpen((previous) => !previous);
  const menu = menuOpen ? (
    <SprayEditorMenu
      counts={counts}
      showMaybes
      canReviewMaybes={false}
      onKeepMaybes={noop}
      onToggleMaybes={noop}
      onStartOver={noop}
      onPreviewHoldsOnly={noop}
      onClose={() => setMenuOpen(false)}
    />
  ) : null;
  return (
    <>
      <Stack.Screen
        options={{
          headerShown: true,
          title: t('sprayMaintenance.screenTitle'),
          headerTransparent: false,
          headerRight: tablet
            ? undefined
            : () => (
                <SprayEditorHeaderActions
                  primaryLabel={primaryLabel}
                  primaryLoading={false}
                  primaryDisabled={false}
                  onPrimary={noop}
                  helpDisabled={false}
                />
              ),
        }}
      />
      <SprayEditorView
        headerInset={0}
        onLayout={onLayout}
        commands={noCommands}
        onShortcut={noop}
        onPencilGesture={noop}
        board={
          photo && frame.width > 0 ? (
            <View
              testID="spray-hold-editor-board"
              style={{ alignSelf: 'stretch', alignItems: 'center', justifyContent: 'center', height: viewport.height }}
            >
              <InteractiveFilterBoard
                backgroundPhotoUrl={photo}
                boardName="spray"
                layoutId={fixture.board.layoutId}
                sizeId={fixture.board.sizeId}
                setIds="1"
                boardWidth={geometry.width}
                boardHeight={geometry.height}
                holdTargets={noHolds}
                renderWidth={frame.width}
                renderHeight={frame.height}
                renderInTransform={renderInTransform}
                viewport={viewport}
                maxScale={8}
                pinchPans
                onArtReadinessChange={onArtReadinessChange}
              />
            </View>
          ) : null
        }
        chrome={
          tablet ? (
            <SprayTabletChrome
              railSide={railSide}
              landscape={landscape}
              insets={insets}
              rail={
                <SprayToolRail
                  side={railSide}
                  onSideChange={setRailSide}
                  windowWidth={area.width}
                  leftInset={insets.left}
                  rightInset={insets.right}
                  locked={false}
                  canUndo={false}
                  canRedo={false}
                  onUndo={noop}
                  onRedo={noop}
                  mode={mode}
                  onModeChange={setMode}
                  maybeControls={false}
                  showMaybes
                  onToggleMaybes={noop}
                  onKeepMaybes={noop}
                  pencilToggleAvailable={false}
                  pencilOnly={false}
                  onTogglePencilOnly={noop}
                  onFit={noop}
                  onMore={toggleMenu}
                  moreExpanded={menuOpen}
                />
              }
              menu={menu}
              inspector={null}
              dock={null}
              counts={counts}
              showMaybes
              celebrating={false}
              locked={false}
              primaryLabel={primaryLabel}
              primaryLoading={false}
              primaryDisabled={false}
              onPrimary={noop}
            />
          ) : (
            <SprayEditorPhoneChromeView
              bottomInset={insets.bottom}
              bottomBar={
                <SprayEditorBottomBar
                  canUndo={false}
                  canRedo={false}
                  mode={mode}
                  onModeChange={setMode}
                  locked={false}
                  bottomInset={insets.bottom}
                  onUndo={noop}
                  onRedo={noop}
                />
              }
              counts={
                <SprayCountCapsule
                  counts={counts}
                  showMaybes
                  celebrating={false}
                  locked={false}
                  onPress={toggleMenu}
                  expanded={menuOpen}
                />
              }
              menu={menu}
            />
          )
        }
      />
    </>
  );
}
export default {
  title: 'Spray walls / Hold editor',
  stories: {
    setting: {
      name: 'Published wall holds',
      layout: 'fullscreen',
      readiness: 'explicit',
      render: (controls) => <SprayEditorStory {...controls} />,
    },
  },
} satisfies StoryModule;
