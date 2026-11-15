import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Button, Share, StyleSheet, Switch, View } from 'react-native';
import type { NativeSyntheticEvent } from 'react-native';
import { Image } from 'expo-image';
import { useIsFocused, useLocalSearchParams } from 'expo-router';
import { getWallLightness, loadBoardArtGeometry } from '@boardsesh/board-art-geometry';
import { boardFieldColorForScheme } from '@boardsesh/board-look';
import {
  compareClimbOverlayGPU,
  NativeClimbOverlayGPU,
  type ClimbOverlayGPUComparison,
} from '../../modules/climb-overlay-gpu/src';
import { renderHoldsOverlay } from '../../modules/board-renderer/src';
import { FeatureFlagsProvider, useFeatureFlag } from '../providers/feature-flags-provider';
import { useTheme } from '../providers/theme-provider';
import { getBoardRenderData } from '../lib/board-details';
import { ensureBackgroundsCached } from '../lib/background-image-cache';
import {
  buildGpuParityConfig,
  buildGpuParityFixtures,
  GPU_PARITY_BOARD,
  GPU_PARITY_FLAG,
  gpuParityParameters,
  type GpuParityMode,
  isCurrentGpuParityRequest,
} from '../dev/stories/gpu-climb-fixtures';
import { StoryVariant } from '../dev/stories/StoryCanvas';
import type { StoryModule } from '../dev/stories/types';
import { spacing } from '../theme/tokens';
import { Text } from './Text';

type GpuResult = {
  requestId: string;
  prepareMs: number;
  uploadMs: number;
  gpuMs: number;
  atlasBytes: number;
  atlasCacheHit: boolean;
};
type Sample = {
  requestId: string;
  fixture: string;
  mode: string;
  outputWidth: number;
  scheme: 'light' | 'dark';
  rustApiMs?: number;
  rustLoadMs?: number;
  gpuCallbackMs?: number;
  gpu?: GpuResult;
};
type Mode = GpuParityMode;
const MODES: readonly Mode[] = ['compare', 'rust', 'metal'];
const RESOLUTIONS = [512, 768, 1024] as const;
const BOARD_PARAMS = { ...GPU_PARITY_BOARD, setIds: [...GPU_PARITY_BOARD.setIds] };
const board = getBoardRenderData(BOARD_PARAMS);
const geometry = loadBoardArtGeometry(GPU_PARITY_BOARD);
const wallLightness = getWallLightness(GPU_PARITY_BOARD);
const fixtures = board ? buildGpuParityFixtures(board.holdsData) : [];

function Parity() {
  const parameters = gpuParityParameters(useLocalSearchParams());
  const [enabled, setEnabled] = useState(parameters.enabled);
  useEffect(() => setEnabled(parameters.enabled), [parameters.enabled]);
  const flags = useMemo(() => ({ [GPU_PARITY_FLAG]: enabled }), [enabled]);
  return (
    <View style={styles.stack}>
      <View style={styles.toggle}>
        <Text>Enable GPU experiment</Text>
        <Switch accessibilityLabel="Enable GPU experiment" value={enabled} onValueChange={setEnabled} />
      </View>
      <FeatureFlagsProvider flags={flags}>
        {board && geometry ? <Comparison /> : <Text>The Homewall art is unavailable in this build.</Text>}
      </FeatureFlagsProvider>
    </View>
  );
}

function Comparison() {
  const parameters = gpuParityParameters(useLocalSearchParams());
  const { colorScheme } = useTheme();
  const scheme = colorScheme === 'dark' ? 'dark' : 'light';
  const focused = useIsFocused();
  const enabled = useFeatureFlag(GPU_PARITY_FLAG) === true;
  const [fixtureIndex, setFixtureIndex] = useState(parameters.sample);
  const [mode, setMode] = useState<Mode>(parameters.mode);
  const [outputWidth, setOutputWidth] = useState<number>(parameters.resolution);
  const [iteration, setIteration] = useState(0);
  const [freshPng, setFreshPng] = useState(0);
  const [backgrounds, setBackgrounds] = useState<string[]>([]);
  const [backgroundError, setBackgroundError] = useState<string | null>(null);
  const [rustImage, setRustImage] = useState<{ requestId: string; uri: string } | null>(null);
  const [rustError, setRustError] = useState<string | null>(null);
  const [gpuError, setGpuError] = useState<string | null>(null);
  const [latest, setLatest] = useState<Sample | null>(null);
  const [sampleCount, setSampleCount] = useState(0);
  const [comparingPixels, setComparingPixels] = useState(false);
  const [pixelResult, setPixelResult] = useState<{ requestId: string; result: ClimbOverlayGPUComparison } | null>(null);
  const [pixelError, setPixelError] = useState<string | null>(null);
  const sessionId = useRef(`gpu-parity-${Date.now()}`);
  const samples = useRef<Sample[]>([]);
  const startedAt = useRef(0);
  const currentRequest = useRef('');
  const mounted = useRef(true);
  const autoVerifiedRequest = useRef('');
  const comparisonInFlight = useRef(false);
  const sample = fixtures[fixtureIndex];
  const configJson = useMemo(
    () =>
      JSON.stringify(
        buildGpuParityConfig({
          boardWidth: board!.boardWidth,
          boardHeight: board!.boardHeight,
          holds: board!.holdsData,
          geometry: geometry!,
          wallLightness,
          colorScheme: scheme,
          frames: sample.frames,
          outputWidth,
        }),
      ),
    [scheme, sample.frames, outputWidth],
  );
  const requestKey = `${scheme}-${fixtureIndex}-${mode}-${iteration}-${freshPng}-${enabled}-${outputWidth}`;
  const [requestIdentity, setRequestIdentity] = useState({ key: requestKey, generation: 0 });
  let currentIdentity = requestIdentity;
  if (requestIdentity.key !== requestKey) {
    // React restarts this component before committing its children. A new
    // generation also distinguishes A → B → A from the original visit to A;
    // unrelated timing/status renders retain the same request identity.
    currentIdentity = { key: requestKey, generation: requestIdentity.generation + 1 };
    setRequestIdentity(currentIdentity);
  }
  const requestId = `${sessionId.current}-${currentIdentity.generation}`;
  const showRust = mode !== 'metal' || !enabled || !NativeClimbOverlayGPU || gpuError !== null;
  const showGpu = mode !== 'rust' && enabled && NativeClimbOverlayGPU !== null && gpuError === null;

  const record = useCallback((eventRequestId: string, fields: Partial<Sample>) => {
    if (!mounted.current || !isCurrentGpuParityRequest(currentRequest.current, eventRequestId)) return;
    const existing = samples.current.find((entry) => entry.requestId === eventRequestId);
    if (!existing) return;
    // Resume/layout callbacks describe the same render again; only the first
    // completion measures this request's latency rather than time spent away.
    Object.assign(existing, {
      rustApiMs: existing.rustApiMs ?? fields.rustApiMs,
      rustLoadMs: existing.rustLoadMs ?? fields.rustLoadMs,
      gpuCallbackMs: existing.gpuCallbackMs ?? fields.gpuCallbackMs,
      gpu: existing.gpu ?? fields.gpu,
    });
    setLatest({ ...existing });
  }, []);

  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    setFixtureIndex(parameters.sample);
    setMode(parameters.mode);
    setOutputWidth(parameters.resolution);
  }, [parameters.sample, parameters.mode, parameters.resolution]);

  useEffect(() => {
    let cancelled = false;
    void ensureBackgroundsCached({ ...BOARD_PARAMS, colorScheme: scheme }).then(
      (result) => {
        if (cancelled) return;
        if (!result || result.missingCount > 0) setBackgroundError('Some board photos are missing from this build.');
        else setBackgroundError(null);
        setBackgrounds(result?.paths ?? []);
      },
      () => {
        if (!cancelled) setBackgroundError('The board photos could not load.');
      },
    );
    return () => {
      cancelled = true;
    };
  }, [scheme]);

  useLayoutEffect(() => {
    currentRequest.current = requestId;
    setGpuError(null);
    setRustError(null);
    setPixelError(null);
    startedAt.current = performance.now();
    const measurement: Sample = { requestId, fixture: sample.name, mode, outputWidth, scheme };
    samples.current = [...samples.current.slice(-99), measurement];
    setSampleCount(samples.current.length);
    setLatest(measurement);
    // Rust-only mode isolates CPU/PNG work; compare mode is visual evidence.
    if (mode === 'metal' && enabled && NativeClimbOverlayGPU) return;
    let cancelled = false;
    const pngKey = `${sessionId.current}-${scheme}-${fixtureIndex}-${freshPng}-${outputWidth}`;
    void renderHoldsOverlay(configJson, pngKey).then(
      (uri) => {
        if (cancelled || !isCurrentGpuParityRequest(currentRequest.current, requestId)) return;
        record(requestId, { rustApiMs: performance.now() - startedAt.current });
        setRustImage({ requestId, uri });
      },
      (error: unknown) => {
        if (!cancelled) setRustError(error instanceof Error ? error.message : String(error));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [requestId, configJson, fixtureIndex, freshPng, scheme, sample.name, mode, enabled, record, outputWidth]);

  const handleGpuReady = useCallback(
    ({ nativeEvent }: NativeSyntheticEvent<GpuResult>) => {
      record(nativeEvent.requestId, { gpu: nativeEvent, gpuCallbackMs: performance.now() - startedAt.current });
    },
    [record],
  );
  const handleGpuError = useCallback(
    ({ nativeEvent }: NativeSyntheticEvent<{ requestId: string; reason: string }>) => {
      if (!mounted.current || !isCurrentGpuParityRequest(currentRequest.current, nativeEvent.requestId)) return;
      setGpuError(nativeEvent.reason);
      // A Metal-only run still falls back to the matching Rust climb on failure.
      if (mode === 'metal') {
        void renderHoldsOverlay(
          configJson,
          `${sessionId.current}-${scheme}-${fixtureIndex}-${freshPng}-${outputWidth}`,
        ).then(
          (uri) => {
            if (mounted.current && isCurrentGpuParityRequest(currentRequest.current, nativeEvent.requestId)) {
              setRustImage({ requestId: nativeEvent.requestId, uri });
            }
          },
          (error: unknown) => {
            if (mounted.current && isCurrentGpuParityRequest(currentRequest.current, nativeEvent.requestId)) {
              setRustError(error instanceof Error ? error.message : String(error));
            }
          },
        );
      }
    },
    [mode, configJson, scheme, fixtureIndex, freshPng, outputWidth],
  );
  const repeat = () => setIteration((previous) => previous + 1);
  const validatePixels = useCallback(async () => {
    if (!compareClimbOverlayGPU || comparisonInFlight.current) return;
    comparisonInFlight.current = true;
    setComparingPixels(true);
    setPixelError(null);
    try {
      const result = await compareClimbOverlayGPU(configJson);
      if (mounted.current && isCurrentGpuParityRequest(currentRequest.current, requestId)) {
        setPixelResult({ requestId, result });
        // eslint-disable-next-line no-console
        console.log(
          '[gpu-climb-parity]',
          JSON.stringify({ requestId, fixture: sample.name, scheme, outputWidth, ...result }),
        );
      }
    } catch (error) {
      if (mounted.current && isCurrentGpuParityRequest(currentRequest.current, requestId)) {
        setPixelError(error instanceof Error ? error.message : String(error));
      }
    } finally {
      comparisonInFlight.current = false;
      if (mounted.current) setComparingPixels(false);
    }
  }, [configJson, requestId, sample.name, scheme, outputWidth]);
  const currentPixels = pixelResult?.requestId === requestId ? pixelResult.result : null;
  const readyForPixels =
    enabled &&
    latest?.requestId === requestId &&
    latest.gpu !== undefined &&
    (mode === 'metal' || latest.rustLoadMs !== undefined);
  useEffect(() => {
    if (
      !parameters.verify ||
      !readyForPixels ||
      !compareClimbOverlayGPU ||
      comparingPixels ||
      comparisonInFlight.current ||
      autoVerifiedRequest.current === requestId
    )
      return;
    autoVerifiedRequest.current = requestId;
    void validatePixels();
  }, [parameters.verify, readyForPixels, requestId, comparingPixels, validatePixels]);
  const displayWidth = mode === 'compare' ? 148 : 300;
  const boardStyle = { width: displayWidth, height: (displayWidth * board!.boardHeight) / board!.boardWidth };
  const backgroundLayers = backgrounds.map((path) => (
    <Image
      key={path}
      source={{ uri: path.startsWith('file:') ? path : `file://${path}` }}
      style={StyleSheet.absoluteFill}
      contentFit="fill"
      transition={0}
    />
  ));
  const milliseconds = (duration: number | undefined) =>
    duration === undefined ? 'pending' : `${duration.toFixed(1)} ms`;

  return (
    <View style={styles.stack}>
      <Text variant="headline">Kilter Homewall · {sample.name}</Text>
      <Text variant="footnote">
        {outputWidth} px overlays. Still drawing only; the player and editor are unchanged.
      </Text>
      <View style={styles.buttons}>
        <Button title="Next sample" onPress={() => setFixtureIndex((previous) => (previous + 1) % fixtures.length)} />
        <Button title={`Mode: ${mode}`} onPress={() => setMode(MODES[(MODES.indexOf(mode) + 1) % MODES.length])} />
        <Button
          title={`${outputWidth} px`}
          onPress={() =>
            setOutputWidth(
              RESOLUTIONS[(RESOLUTIONS.findIndex((width) => width === outputWidth) + 1) % RESOLUTIONS.length],
            )
          }
        />
      </View>
      <View style={styles.buttons}>
        <Button title="Repeat cached key" onPress={repeat} />
        <Button title="Fresh Rust PNG" onPress={() => setFreshPng((previous) => previous + 1)} />
      </View>
      {backgroundError ? <Text>{backgroundError}</Text> : null}
      <View style={styles.boards}>
        {showRust ? (
          <StoryVariant label={mode === 'metal' ? 'Rust fallback' : 'Rust PNG'}>
            <View style={[boardStyle, { backgroundColor: boardFieldColorForScheme(scheme) }]}>
              {backgroundLayers}
              {rustImage?.requestId === requestId ? (
                <Image
                  key={requestId}
                  source={{ uri: rustImage.uri }}
                  style={StyleSheet.absoluteFill}
                  contentFit="fill"
                  transition={0}
                  onLoad={() => record(requestId, { rustLoadMs: performance.now() - startedAt.current })}
                  onError={() => {
                    if (mounted.current && isCurrentGpuParityRequest(currentRequest.current, requestId)) {
                      setRustError('The generated Rust image could not load.');
                    }
                  }}
                />
              ) : null}
            </View>
          </StoryVariant>
        ) : null}
        {showGpu && NativeClimbOverlayGPU ? (
          <StoryVariant label="Metal shader">
            <View style={[boardStyle, { backgroundColor: boardFieldColorForScheme(scheme) }]}>
              {backgroundLayers}
              <NativeClimbOverlayGPU
                style={StyleSheet.absoluteFill}
                configJson={configJson}
                requestId={requestId}
                active={focused && !comparingPixels}
                onRenderReady={handleGpuReady}
                onRenderError={handleGpuError}
              />
            </View>
          </StoryVariant>
        ) : null}
      </View>
      {!enabled ? <Text>GPU drawing is disabled. Enable the experiment above.</Text> : null}
      {enabled && !NativeClimbOverlayGPU ? <Text>This binary has no GPU climb module. Showing Rust.</Text> : null}
      {gpuError ? <Text>GPU unavailable: {gpuError}. Showing Rust.</Text> : null}
      {rustError ? <Text>Rust render failed: {rustError}</Text> : null}
      <Text variant="footnote">
        Use Rust or Metal mode for isolated timings. Compare mode runs both and is for appearance.
      </Text>
      <Text variant="footnote" numeric>
        Rust API / PNG ready: {milliseconds(latest?.rustApiMs)} · image onLoad: {milliseconds(latest?.rustLoadMs)}
      </Text>
      <Text variant="footnote" numeric>
        Metal callback: {milliseconds(latest?.gpuCallbackMs)} · GPU: {milliseconds(latest?.gpu?.gpuMs)}
      </Text>
      <Text variant="footnote" numeric>
        Atlas prepare: {milliseconds(latest?.gpu?.prepareMs)} · upload: {milliseconds(latest?.gpu?.uploadMs)}
      </Text>
      <Text variant="footnote">
        Atlas {latest?.gpu ? (latest.gpu.atlasCacheHit ? 'reused' : 'prepared') : 'pending'} ·{' '}
        {latest?.gpu ? `${(latest.gpu.atlasBytes / 1048576).toFixed(1)} MiB` : '—'} · {sampleCount} samples
      </Text>
      <Text variant="footnote">
        Callbacks do not prove screen presentation. Cached keys may miss on their first run. Relaunch for a cold atlas.
      </Text>
      <Button
        title={comparingPixels ? 'Comparing pixels…' : 'Validate pixels'}
        disabled={!readyForPixels || comparingPixels || !compareClimbOverlayGPU}
        onPress={() => void validatePixels()}
      />
      {pixelError ? <Text>Pixel comparison failed: {pixelError}</Text> : null}
      {currentPixels ? (
        <View style={styles.stack}>
          <Text variant="footnote" numeric>
            RGBA comparison · {currentPixels.width} × {currentPixels.height} · maximum channel error{' '}
            {currentPixels.maxChannelError} / 255 · RMSE {currentPixels.rmse.toFixed(3)} · {currentPixels.pixelsOverOne}{' '}
            pixels differ by more than 1.
          </Text>
          <Text variant="footnote">
            Offscreen snapshots saved. These compare pixels at atlas resolution; they do not time screen presentation.
          </Text>
          <View style={styles.boards}>
            <StoryVariant label="Rust snapshot">
              <Image source={{ uri: currentPixels.referenceUri }} style={boardStyle} contentFit="contain" />
            </StoryVariant>
            <StoryVariant label="Metal snapshot">
              <Image source={{ uri: currentPixels.gpuUri }} style={boardStyle} contentFit="contain" />
            </StoryVariant>
          </View>
        </View>
      ) : null}
      <View style={styles.buttons}>
        <Button
          title="Share measurements"
          onPress={() =>
            void Share.share({
              message: JSON.stringify(
                { board: GPU_PARITY_BOARD, scheme, samples: samples.current, pixelComparison: currentPixels },
                null,
                2,
              ),
            })
          }
        />
        <Button
          title="Reset readings"
          onPress={() => {
            samples.current = [];
            setSampleCount(0);
            setLatest(null);
          }}
        />
      </View>
    </View>
  );
}

const stories: StoryModule = {
  title: 'GPU climb overlay / Kilter Homewall parity',
  stories: { parity: { name: 'Rust vs Metal, still', render: () => <Parity /> } },
};
export default stories;

const styles = StyleSheet.create({
  stack: { gap: spacing[3] },
  toggle: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  buttons: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing[2] },
  boards: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing[2] },
});
