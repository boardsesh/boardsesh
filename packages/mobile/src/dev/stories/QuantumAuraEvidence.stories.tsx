import { useCallback, useMemo, useState } from 'react';
import { Pressable, StyleSheet, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { HOLD_STATE_MAP } from '@boardsesh/board-constants/hold-states';
import type { Climb } from '@boardsesh/shared-schema';
import { FeatureFlagsProvider } from '../../providers/feature-flags-provider';
import { ContentRenderObserverProvider, type ContentRenderObservation } from '../../components/ContentRenderObserver';
import { HeatmapOverlay } from '../../components/board/HeatmapOverlay';
import type { HeatLayer } from '../../components/board/heatmap-buckets';
import { InteractiveCreateBoard } from '../../components/create-climb/InteractiveCreateBoard';
import { ClimbsStory } from '../../components/climbs/Climbs.stories';
import { Text } from '../../components/Text';
import { getCreateBoardHolds } from '../../lib/create-board-holds';
import { getBoardRenderData } from '../../lib/board-details';
import { requestedBoardRenderMode, useBoardRenderSettings } from '../../lib/board-render-settings';
import type { BoardArtReadiness } from '../../lib/board-render/ready-board-art';
import { climbOverlayGpuApiVersion } from '../../lib/board-render/gpu-native-capability';
import { STORY_CLIMBS } from '../fixtures/climbs';
import type { StoryBoardFixture } from '../fixtures/boards';
import { StoryBoardFixtureContext } from './story-board-fixture';
import { PlayerScene } from './PlayerScene';
import type { StoryModule, StoryRenderControls } from './types';

const configurations = {
  xl: { layoutId: 9101, sizeId: 9201 },
  l: { layoutId: 9101, sizeId: 9202 },
  m: { layoutId: 9101, sizeId: 9203 },
  s: { layoutId: 9104, sizeId: 9204 },
} as const;
type Model = keyof typeof configurations;
const flags = { 'quantum-board': true, 'aura-gpu-enabled': true };
const noop = () => {};

/** Synthetic problems over the exact shipped Quantum placements; no backend recording. */
function buildFixture(model: Model): StoryBoardFixture {
  const board = { boardName: 'quantum' as const, ...configurations[model], setIds: '1', angle: 40 };
  const geometry = getBoardRenderData({ ...board, setIds: [1] });
  if (!geometry?.holdsData.length) throw new Error('Quantum evidence requires bundled geometry');
  const roleCode = (name: string) =>
    Number(Object.entries(HOLD_STATE_MAP.quantum).find(([, role]) => role.name === name)?.[0]);
  const climbs: Climb[] = Array.from({ length: 11 }, (_, climbIndex) => {
    const selected = new Set<number>();
    const targets = [
      [0.4, 0.8],
      [0.6, 0.8],
      [0.3, 0.65],
      [0.65, 0.5],
      [0.4, 0.35],
      [0.6, 0.15],
    ];
    const frames = targets
      .map(([horizontal, vertical], targetIndex) => {
        const targetX = (horizontal + ((climbIndex % 3) - 1) * 0.06) * geometry.boardWidth;
        const targetY = (vertical + ((Math.floor(climbIndex / 3) % 3) - 1) * 0.025) * geometry.boardHeight;
        const candidates = geometry.holdsData.filter((hold) => !selected.has(hold.id));
        const nearest = candidates.reduce((closest, hold) =>
          Math.hypot(hold.cx - targetX, hold.cy - targetY) < Math.hypot(closest.cx - targetX, closest.cy - targetY)
            ? hold
            : closest,
        );
        selected.add(nearest.id);
        return `p${nearest.id}r${roleCode(targetIndex < 2 ? 'STARTING' : targetIndex === 5 ? 'FINISH' : 'HAND')}`;
      })
      .join('');
    return {
      ...STORY_CLIMBS[0],
      uuid: `quantum-evidence-${model}-${climbIndex}`,
      name: `Quantum ${model.toUpperCase()} circuit ${climbIndex + 1}`,
      boardType: 'quantum',
      layoutId: board.layoutId,
      angle: 40,
      frames,
      framesCount: 1,
    };
  });
  return { board, climbs };
}
const fixtures = Object.fromEntries(
  Object.keys(configurations).map((model) => [model, buildFixture(model as Model)]),
) as Record<Model, StoryBoardFixture>;

function Editor({ model, onReady, onError }: StoryRenderControls & { model: Model }) {
  const fixture = fixtures[model];
  const geometry = useMemo(() => getCreateBoardHolds({ ...fixture.board, setIds: [1] }), [fixture]);
  const [frames, setFrames] = useState(fixture.climbs[0].frames);
  const [heatmapVisible, setHeatmapVisible] = useState(false);
  const heatLayer = useMemo<HeatLayer>(
    () => ({
      cells: (geometry?.holdTargets ?? [])
        .filter((_, index) => index % 23 === 0)
        .map((hold) => ({ holdId: hold.id, bucket: 4, code: 904, color: '#ff8800' })),
      codeColors: { 904: { color: '#ff8800' } },
      legend: { kind: 'count', edgeValues: [1, 2, 3, 4, 5], total: 5 },
    }),
    [geometry],
  );
  const window = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const readiness = useCallback(
    (state: BoardArtReadiness) => {
      if (state === 'ready') onReady();
      if (state === 'failed') onError(new Error('Quantum editor artwork failed'));
    },
    [onReady, onError],
  );
  const paint = useCallback((holdId: number) => {
    // eslint-disable-next-line no-console
    console.log(`[quantum-evidence] editor tapped hold=${holdId}`);
    setFrames((previous) => `${previous}p${holdId}r13`);
  }, []);
  if (!geometry) throw new Error('Quantum editor geometry missing');
  const width = Math.min(
    window.width - 32,
    ((window.height - insets.top - insets.bottom - 100) * geometry.boardWidth) / geometry.boardHeight,
  );
  return (
    <View style={[styles.editor, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
      <Text variant="title2">Quantum {model.toUpperCase()} hold editor</Text>
      <InteractiveCreateBoard
        {...fixture.board}
        boardWidth={geometry.boardWidth}
        boardHeight={geometry.boardHeight}
        holdTargets={geometry.holdTargets}
        frames={frames}
        litUpHoldsMap={{}}
        onPaint={paint}
        onLongPressHold={noop}
        renderWidth={width}
        renderHeight={(width * geometry.boardHeight) / geometry.boardWidth}
        onArtReadinessChange={readiness}
        overlay={
          heatmapVisible ? (
            <HeatmapOverlay
              {...fixture.board}
              layer={heatLayer}
              holdTargets={geometry.holdTargets}
              boardWidth={geometry.boardWidth}
              boardHeight={geometry.boardHeight}
            />
          ) : undefined
        }
      />
      <Pressable accessibilityRole="button" onPress={() => setHeatmapVisible((visible) => !visible)}>
        <Text variant="footnote">{heatmapVisible ? 'Hide heatmap' : 'Show heatmap'}</Text>
      </Pressable>
    </View>
  );
}

function Evidence({
  model,
  surface,
  onReady,
  onError,
}: StoryRenderControls & { model: Model; surface: 'player' | 'list' | 'editor' }) {
  const fixture = fixtures[model];
  const { settings, loaded } = useBoardRenderSettings();
  const presentation = useMemo(() => ({ ...fixture, label: `Quantum ${model.toUpperCase()}` }), [fixture, model]);
  const displayed = useCallback(
    (observation: ContentRenderObservation) => {
      if (observation.route === 'play-drawer' && observation.count > 0) {
        // eslint-disable-next-line no-console
        console.log(
          `[quantum-evidence] painted ${model} API${climbOverlayGpuApiVersion} holds=${observation.count} holdShape=${settings.boardsesh.holdShape} softDisc=${settings.boardsesh.softDisc} glowReach=${settings.boardsesh.glowReach}`,
        );
        onReady();
      }
    },
    [onReady, model, settings.boardsesh.holdShape, settings.boardsesh.softDisc, settings.boardsesh.glowReach],
  );
  if (!loaded) return null;
  if (
    requestedBoardRenderMode(settings) !== 'aura' ||
    settings.boardsesh.holdShape !== 'silhouette' ||
    settings.boardsesh.softDisc
  )
    throw new Error(`Quantum evidence requires Aura silhouettes; simulator settings: ${JSON.stringify(settings)}`);
  return (
    <FeatureFlagsProvider flags={flags}>
      <StoryBoardFixtureContext.Provider value={presentation}>
        <ContentRenderObserverProvider onContentRendered={displayed}>
          {surface === 'player' ? (
            <PlayerScene fixture={fixture} swipeBoard onReady={onReady} onError={onError} />
          ) : surface === 'list' ? (
            <ClimbsStory scene="populated" onReady={onReady} onError={onError} />
          ) : (
            <Editor model={model} onReady={onReady} onError={onError} />
          )}
        </ContentRenderObserverProvider>
      </StoryBoardFixtureContext.Provider>
    </FeatureFlagsProvider>
  );
}
const stories: StoryModule = {
  title: 'Quantum Aura evidence',
  stories: Object.fromEntries(
    (Object.keys(configurations) as Model[]).flatMap((model) =>
      (['player', 'list', 'editor'] as const).map((surface) => [
        `${model}-${surface}`,
        {
          name: `Quantum ${model} ${surface}`,
          layout: 'fullscreen' as const,
          readiness: 'explicit' as const,
          render: (controls: StoryRenderControls) => <Evidence model={model} surface={surface} {...controls} />,
        },
      ]),
    ),
  ),
};
export default stories;
const styles = StyleSheet.create({ editor: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 16 } });
