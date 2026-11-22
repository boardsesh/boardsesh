import { parseFramesToHoldRows } from '@boardsesh/board-constants/hold-states';
import { Stack, useRouter } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { Platform, StyleSheet, View, useWindowDimensions, type LayoutChangeEvent } from 'react-native';
import { ScrollView } from 'react-native-gesture-handler';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { STORY_BOARDS } from '../../dev/fixtures/boards';
import { useStoryBoardFixture } from '../../dev/stories/story-board-fixture';
import { StorySprayBoard } from '../../dev/stories/StorySprayBoard';
import type { StoryModule, StoryRenderControls } from '../../dev/stories/types';
import { useWindowBottomInset } from '../../hooks/use-window-bottom-inset';
import { useTheme } from '../../providers/theme-provider';
import { CreateAddHoldsRow } from './CreateAddHoldsRow';
import { CreateDrawerActionBar } from './CreateDrawerActionBar';
import { CreateDrawerFormView } from './CreateDrawerFormView';
import { CreateDrawerHeader } from './CreateDrawerHeader';
import { computeBoardMaxHeight } from './create-drawer-layout';
import { deriveDraftStatusView, draftStatusWithHoldEditorFailure } from './draft-status-view';
import type { BrushRole } from './brush-roles';
import type { CreateOverflowAction } from './create-overflow-menu';

type CreateClimbStoryState = 'spraywall' | 'empty' | 'longTitle' | 'loading' | 'error';
type HoldEditorState = 'idle' | 'opening' | 'failed';

const noop = () => {};

/** Real editor views with local state; no account, queries, draft storage or board connection. */
function CreateClimbStory({ state, onReady, onError }: StoryRenderControls & { state: CreateClimbStoryState }) {
  const activeFixture = useStoryBoardFixture();
  const fixture = activeFixture.spray ? activeFixture : STORY_BOARDS['spray-liz'];
  const geometry = fixture.spray;
  if (!geometry) throw new Error('Create climb story requires a spray wall photo fixture');

  const { systemColors, spacing } = useTheme();
  const { t } = useTranslation('climbs');
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const windowInsetBottom = useWindowBottomInset();
  // The production route is a native iOS pageSheet; other platforms clear the status bar here.
  const topInset = Platform.OS === 'ios' ? 0 : insets.top;
  const windowDimensions = useWindowDimensions();
  const initialClimb = fixture.climbs[0];
  const initialFrames = state === 'empty' ? '' : initialClimb.frames;
  const [name, setName] = useState(
    state === 'empty'
      ? ''
      : state === 'longTitle'
        ? 'The very long traverse past the blue pinch and all the way back home'
        : initialClimb.name,
  );
  const [description, setDescription] = useState(
    state === 'empty' ? '' : 'Keep the left heel high, then match the pinch.',
  );
  const [selectedBrush, setSelectedBrush] = useState<BrushRole>('HAND');
  const [heatmapActive, setHeatmapActive] = useState(false);
  const [cleared, setCleared] = useState(false);
  const [redoAvailable, setRedoAvailable] = useState(false);
  const [saved, setSaved] = useState(false);
  const [noMatch, setNoMatch] = useState(false);
  const [campus, setCampus] = useState(false);
  const [anyFeet, setAnyFeet] = useState(
    () => !parseFramesToHoldRows('spray', initialFrames).some((hold) => hold.holdState === 'FOOT'),
  );
  const [isDraft, setIsDraft] = useState(false);
  const [holdEditorState, setHoldEditorState] = useState<HoldEditorState>(
    state === 'loading' ? 'opening' : state === 'error' ? 'failed' : 'idle',
  );
  const [host, setHost] = useState({ width: windowDimensions.width, height: windowDimensions.height });
  const [actionBarHeight, setActionBarHeight] = useState<number | undefined>(undefined);
  const frames = cleared ? '' : initialFrames;
  const paintedHolds = useMemo(() => parseFramesToHoldRows('spray', frames), [frames]);
  const startingCount = paintedHolds.filter((hold) => hold.holdState === 'STARTING').length;
  const finishCount = paintedHolds.filter((hold) => hold.holdState === 'FINISH').length;
  const hasHolds = paintedHolds.length > 0;
  const climbReady = hasHolds && (isDraft || (startingCount > 0 && finishCount > 0));
  const boardMaxHeight = computeBoardMaxHeight({
    windowHeight: host.height,
    insetTop: insets.top,
    insetBottom: windowInsetBottom,
    showRouteTransport: false,
    actionBarHeight,
  });
  const boardHeight = Math.min(boardMaxHeight, ((host.width - spacing[4] * 2) * geometry.height) / geometry.width);
  const draftStatus = deriveDraftStatusView(
    {
      hasContent: hasHolds || name.length > 0 || description.length > 0,
      localPersistenceAvailable: true,
      hasSavedClimb: saved,
      hasUnsavedEdits: !saved,
      saveFailed: false,
      publishBlocked: !isDraft && !(startingCount > 0 && finishCount > 0),
      noHolds: !hasHolds,
      isDraft,
    },
    t,
  );

  const measureHost = useCallback(({ nativeEvent: { layout } }: LayoutChangeEvent) => {
    if (layout.width <= 0 || layout.height <= 0) return;
    setHost((previous) =>
      previous.width === layout.width && previous.height === layout.height
        ? previous
        : { width: layout.width, height: layout.height },
    );
  }, []);
  const measureActionBar = useCallback(({ nativeEvent: { layout } }: LayoutChangeEvent) => {
    if (layout.height > 0) {
      setActionBarHeight((previous) => (previous === layout.height ? previous : layout.height));
    }
  }, []);
  const changeAnyFeet = useCallback((next: boolean) => {
    setAnyFeet(next);
    if (next) setCampus(false);
  }, []);
  const changeCampus = useCallback((next: boolean) => {
    setCampus(next);
    if (next) setAnyFeet(false);
  }, []);
  const handleClose = useCallback(() => {
    if (router.canGoBack()) router.back();
    else router.replace('/dev/stories');
  }, [router]);
  const toggleHeatmap = useCallback(() => setHeatmapActive((active) => !active), []);
  const handleOverflow = useCallback((action: CreateOverflowAction) => {
    if (action === 'newClimb') {
      setName('');
      setDescription('');
      setCleared(true);
      setRedoAvailable(false);
      setSaved(false);
    }
  }, []);

  return (
    <View
      onLayout={measureHost}
      style={[styles.root, { paddingTop: topInset, backgroundColor: systemColors.secondaryBackground }]}
    >
      <Stack.Screen options={{ headerShown: false, presentation: 'modal', gestureEnabled: true }} />
      <CreateDrawerHeader
        name={name}
        onChangeName={setName}
        startingCount={startingCount}
        finishCount={finishCount}
        focusSignal={0}
        onClose={handleClose}
        overflow={{ supportsMultiFrame: true, routeMode: false, frameCount: 1, holdListVisible: false }}
        onSelectOverflowAction={handleOverflow}
        saveState={saved ? 'justSaved' : 'ready'}
        onSave={() => setSaved(true)}
        climbReady={climbReady}
      />
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={{ paddingBottom: windowInsetBottom + spacing[4] }}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        automaticallyAdjustKeyboardInsets
      >
        <View
          testID="create-climb-story-board"
          style={{ height: boardHeight, marginTop: spacing[2], paddingHorizontal: spacing[4] }}
        >
          <StorySprayBoard geometry={geometry} frames={frames} onReady={onReady} onError={onError} />
        </View>
        <View testID="create-climb-story-actions" onLayout={measureActionBar}>
          <CreateDrawerActionBar
            boardName="spray"
            selectedBrush={selectedBrush}
            onSelectBrush={setSelectedBrush}
            canUndo={cleared && initialFrames.length > 0}
            canRedo={redoAvailable}
            onUndo={() => {
              setCleared(false);
              setRedoAvailable(true);
            }}
            onRedo={() => {
              setCleared(true);
              setRedoAvailable(false);
            }}
            onClearHolds={() => {
              setCleared(true);
              setRedoAvailable(false);
            }}
            frameCount={1}
            frameDeletions={0}
            currentFrameIndex={0}
            canSetActive={hasHolds}
            onSetActive={noop}
            draftStatus={draftStatusWithHoldEditorFailure(draftStatus, holdEditorState === 'failed')}
            onToggleHeatmap={toggleHeatmap}
            heatmapActive={heatmapActive}
          />
        </View>
        <CreateAddHoldsRow
          onPress={() => setHoldEditorState('opening')}
          opening={holdEditorState === 'opening'}
          failed={holdEditorState === 'failed'}
        />
        <View style={{ paddingHorizontal: spacing[4], paddingTop: spacing[4] }}>
          <CreateDrawerFormView
            partnerAppsEnabled={false}
            boardName="spray"
            sprayWallPublic
            description={description}
            onChangeDescription={setDescription}
            noMatch={noMatch}
            onChangeNoMatch={setNoMatch}
            noKickboard={false}
            onChangeNoKickboard={noop}
            campus={campus}
            onChangeCampus={changeCampus}
            anyFeet={anyFeet}
            onChangeAnyFeet={changeAnyFeet}
            anyFeetAvailable
            isDraft={isDraft}
            onChangeIsDraft={setIsDraft}
          />
        </View>
      </ScrollView>
    </View>
  );
}

export default {
  title: 'Create climb / Spraywall',
  stories: {
    spraywall: {
      name: 'Painted climb on a spray wall',
      layout: 'fullscreen',
      readiness: 'explicit',
      render: (controls) => <CreateClimbStory {...controls} state="spraywall" />,
    },
    empty: {
      name: 'Empty climb',
      layout: 'fullscreen',
      readiness: 'explicit',
      render: (controls) => <CreateClimbStory {...controls} state="empty" />,
    },
    longTitle: {
      name: 'Long climb name',
      layout: 'fullscreen',
      readiness: 'explicit',
      render: (controls) => <CreateClimbStory {...controls} state="longTitle" />,
    },
    loading: {
      name: 'Opening the hold editor',
      layout: 'fullscreen',
      readiness: 'explicit',
      render: (controls) => <CreateClimbStory {...controls} state="loading" />,
    },
    error: {
      name: 'Hold editor could not open',
      layout: 'fullscreen',
      readiness: 'explicit',
      render: (controls) => <CreateClimbStory {...controls} state="error" />,
    },
  },
} satisfies StoryModule;

const styles = StyleSheet.create({
  root: { flex: 1 },
  scroll: { flex: 1 },
});
