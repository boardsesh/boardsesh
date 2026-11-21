/**
 * The board motion lab screen (docs/rendering/board-motion-lab.md): a caption bar, the
 * real player board, a status line and controls. Nothing is drawn over the board.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ScrollView, StyleSheet, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useLocalSearchParams } from 'expo-router';
import * as Clipboard from 'expo-clipboard';
import { SegmentedControl } from '../SegmentedControl';
import { Text } from '../Text';
import { getBoardRenderData } from '../../lib/board-details';
import { climbOverlayGpuApiVersion, climbOverlaySwapLookVersion } from '../../lib/board-render/gpu-native-capability';
import { useTheme } from '../../providers/theme-provider';
import { borderRadius, spacing } from '../../theme/tokens';
import {
  AUTOPLAY_IDLE,
  autoplayQueue,
  isAutoplayRunning,
  scriptTimeoutMs,
  stepAutoplay,
  type AutoplayEffect,
  type AutoplayEvent,
  type AutoplayState,
} from './autoplay';
import { ActionButton } from './controls/ActionButton';
import { OptionList } from './controls/OptionList';
import { ParamSlider } from './controls/ParamSlider';
import { Section } from './controls/Section';
import { captionText, formatStatus, variantAvailability } from './controls/status-text';
import { LAB_BOARDS, climbSetsFor, findLabBoard } from './fixtures';
import { LabStage } from './LabStage';
import { SPEED_CHOICES, parseLabParams, slowdownForSpeed, speedLabel, type SpeedChoice } from './params';
import { FINGER_SCRIPTS, SHOWCASE_SCRIPT } from './scripts';
import type { FingerScript, LabPreset, LabRenderStatus, ParamValues, ReduceMotionChoice } from './types';
import { fingerScriptMs } from './use-virtual-finger';
import { BOARD_MOTION_VARIANTS, DEFAULT_VARIANT_ID } from './variants';

const STAGE_MAX_HEIGHT_RATIO = 0.5;
const COPIED_LABEL_MS = 1500;
const SHOWCASE_SCRIPT_MS = fingerScriptMs(SHOWCASE_SCRIPT);
const REDUCE_MOTION_OPTIONS = [
  { key: 'system', label: 'System' },
  { key: 'on', label: 'On' },
  { key: 'off', label: 'Off' },
];
const SPEED_OPTIONS = SPEED_CHOICES.map((speed) => ({ key: String(speed), label: speedLabel(speed) }));
const PRESET_OPTIONS = [
  { key: 'subtle', label: 'Subtle' },
  { key: 'bold', label: 'Bold' },
];

function defaultsFor(params: readonly { key: string; default: number }[]): ParamValues {
  return Object.fromEntries(params.map((spec) => [spec.key, spec.default]));
}

export default function BoardMotionLabScreen() {
  const rawParams = useLocalSearchParams<Record<string, string | string[]>>();
  // The deep link is read once; later changes to the route params don't restart the lab.
  const [link] = useState(() => parseLabParams(rawParams));
  const { systemColors } = useTheme();
  const insets = useSafeAreaInsets();
  const { width: windowWidth, height: windowHeight } = useWindowDimensions();

  const availableVariants = useMemo(
    () =>
      BOARD_MOTION_VARIANTS.filter(
        (candidate) => variantAvailability(candidate, climbOverlayGpuApiVersion, climbOverlaySwapLookVersion).available,
      ),
    [],
  );
  const firstVariant =
    availableVariants.find((candidate) => candidate.id === DEFAULT_VARIANT_ID) ??
    availableVariants[0] ??
    BOARD_MOTION_VARIANTS[0];
  // A linked variant this build can't run falls back to firstVariant.
  const linkedVariant = availableVariants.find((candidate) => candidate.id === link.variant);

  const [variantId, setVariantId] = useState(linkedVariant?.id ?? firstVariant.id);
  const [boardId, setBoardId] = useState(findLabBoard(link.board).id);
  const [setId, setSetId] = useState(link.set ?? 'real');
  const [speed, setSpeed] = useState<SpeedChoice>(link.speed ?? 1);
  const [reduceMotion, setReduceMotion] = useState<ReduceMotionChoice>(link.reduceMotion ?? 'system');
  const [overrides, setOverrides] = useState<Record<string, ParamValues>>({});
  // One choice for every variant, so Play all can run them all on Bold.
  const [preset, setPreset] = useState<LabPreset>(link.preset ?? 'subtle');
  const [status, setStatus] = useState<LabRenderStatus>({ path: 'loading' });
  const [scriptId, setScriptId] = useState(FINGER_SCRIPTS[0]?.id ?? '');
  const [script, setScript] = useState<{ script: FingerScript; runId: number } | null>(null);
  const [autoplayState, setAutoplayState] = useState<AutoplayState>(AUTOPLAY_IDLE);
  // Bumped as each Play-all segment starts: the stage goes back to the set's first climb.
  const [stageResetKey, setStageResetKey] = useState(0);
  const [copied, setCopied] = useState(false);

  const variant = BOARD_MOTION_VARIANTS.find((candidate) => candidate.id === variantId) ?? firstVariant;
  const board = findLabBoard(boardId);
  const climbSets = useMemo(() => climbSetsFor(board), [board]);
  const climbSet = climbSets.find((candidate) => candidate.id === setId) ?? climbSets[0];
  const presetParams = preset === 'bold' ? variant.boldParams : undefined;
  const params = useMemo(
    () => ({ ...defaultsFor(variant.params), ...presetParams, ...overrides[variant.id] }),
    [variant, presetParams, overrides],
  );

  const boardAspect = useMemo(() => {
    const renderData = getBoardRenderData({ ...board, setIds: board.setIds.split(',').map(Number) });
    return renderData ? renderData.boardWidth / renderData.boardHeight : 1080 / 1920;
  }, [board]);
  const stageHeight = Math.min(windowWidth / boardAspect, windowHeight * STAGE_MAX_HEIGHT_RATIO);
  const slowdown = slowdownForSpeed(speed);

  const autoplayRef = useRef<AutoplayState>(AUTOPLAY_IDLE);
  const timersRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  const runIdRef = useRef(0);
  // Read when Play all starts a script, to time it at the speed chosen then.
  const slowdownRef = useRef(slowdown);
  useEffect(() => {
    slowdownRef.current = slowdown;
  }, [slowdown]);

  // Every variant change goes through here, so the ref is always the one shown.
  const variantIdRef = useRef(variantId);
  const selectVariant = useCallback((nextId: string) => {
    if (variantIdRef.current === nextId) return;
    variantIdRef.current = nextId;
    // In the same render as the new variant: Play all must not read the old
    // variant's status as the new one being ready.
    setStatus({ path: 'loading' });
    setVariantId(nextId);
  }, []);

  const dispatchRef = useRef<(event: AutoplayEvent) => void>(() => undefined);
  const runEffect = useCallback(
    (effect: AutoplayEffect) => {
      switch (effect.kind) {
        case 'select-variant':
          selectVariant(effect.variantId);
          setStageResetKey((current) => current + 1);
          break;
        case 'play-script':
          runIdRef.current += 1;
          setScript({ script: SHOWCASE_SCRIPT, runId: runIdRef.current });
          break;
        case 'stop-script':
          setScript(null);
          break;
        case 'after':
          timersRef.current.push(setTimeout(() => dispatchRef.current(effect.event), effect.ms));
          break;
      }
    },
    [selectVariant],
  );
  const dispatchAutoplay = useCallback(
    (event: AutoplayEvent) => {
      const step = stepAutoplay(autoplayRef.current, event, {
        scriptTimeoutMs: scriptTimeoutMs(SHOWCASE_SCRIPT_MS, slowdownRef.current),
      });
      if (step.effects.some((effect) => effect.kind === 'after') || event.type === 'cancel') {
        timersRef.current.forEach(clearTimeout);
        timersRef.current = [];
      }
      autoplayRef.current = step.state;
      setAutoplayState(step.state);
      step.effects.forEach(runEffect);
    },
    [runEffect],
  );
  dispatchRef.current = dispatchAutoplay;

  const startAutoplay = useCallback(
    (queue: string[]) => dispatchAutoplay({ type: 'start', variantIds: queue }),
    [dispatchAutoplay],
  );

  useEffect(() => {
    let launch: ReturnType<typeof setTimeout> | undefined;
    if (link.autoplay) {
      const queue = autoplayQueue(
        link.autoplay,
        availableVariants.map((candidate) => candidate.id),
      );
      // Give the stage a moment to mount first.
      launch = setTimeout(() => startAutoplay(queue), 500);
    }
    return () => {
      if (launch) clearTimeout(launch);
      timersRef.current.forEach(clearTimeout);
      timersRef.current = [];
    };
  }, [link.autoplay, availableVariants, startAutoplay]);

  useEffect(() => {
    if (
      autoplayState.phase === 'awaiting-ready' &&
      status.path !== 'loading' &&
      variantId === autoplayState.queue[autoplayState.index]
    ) {
      dispatchAutoplay({ type: 'ready' });
    }
  }, [autoplayState, status, variantId, dispatchAutoplay]);

  const handleScriptDone = useCallback(
    (runId: number) => {
      // Cleared once done: the board takes touches again, and nothing can replay it.
      setScript((current) => (current?.runId === runId ? null : current));
      if (runId === runIdRef.current) dispatchAutoplay({ type: 'script-done' });
    },
    [dispatchAutoplay],
  );

  const running = isAutoplayRunning(autoplayState);
  const scriptPlaying = script !== null;
  const playSelectedScript = useCallback(() => {
    const chosen = FINGER_SCRIPTS.find((candidate) => candidate.id === scriptId) ?? FINGER_SCRIPTS[0];
    if (!chosen) return;
    runIdRef.current += 1;
    setScript({ script: chosen, runId: runIdRef.current });
  }, [scriptId]);

  const handleParamCommit = useCallback(
    (key: string, value: number) =>
      setOverrides((current) => ({ ...current, [variant.id]: { ...current[variant.id], [key]: value } })),
    [variant.id],
  );
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
    },
    [],
  );
  const copyParams = useCallback(async () => {
    await Clipboard.setStringAsync(JSON.stringify({ variant: variant.id, preset, params }, null, 2));
    setCopied(true);
    if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
    copiedTimerRef.current = setTimeout(() => setCopied(false), COPIED_LABEL_MS);
  }, [variant.id, preset, params]);
  /** Loads a preset into the sliders: this variant's own slider changes go. */
  const choosePreset = useCallback(
    (next: LabPreset) => {
      setPreset(next);
      setOverrides((current) => ({ ...current, [variant.id]: {} }));
    },
    [variant.id],
  );

  const variantOptions = BOARD_MOTION_VARIANTS.map((candidate) => {
    const availability = variantAvailability(candidate, climbOverlayGpuApiVersion, climbOverlaySwapLookVersion);
    return {
      key: candidate.id,
      label: `${candidate.letter} · ${candidate.name}`,
      disabledReason: availability.available ? undefined : availability.reason,
    };
  });

  return (
    <View style={[styles.root, { backgroundColor: systemColors.groupedBackground }]}>
      <View style={[styles.caption, { paddingTop: spacing[2], backgroundColor: systemColors.background }]}>
        <Text variant="title2" emphasized numberOfLines={1}>
          {captionText(variant)}
        </Text>
        <Text variant="callout" tone="secondary" numeric numberOfLines={1}>
          {speedLabel(speed)} · {board.label}
        </Text>
      </View>
      <View style={{ width: windowWidth, height: stageHeight, alignSelf: 'center' }}>
        <LabStage
          board={board}
          climbs={climbSet.climbs}
          variant={variant}
          params={params}
          slowdown={slowdown}
          reduceMotion={reduceMotion}
          script={script}
          onScriptDone={handleScriptDone}
          onStatus={setStatus}
          resetKey={stageResetKey}
        />
      </View>
      <Text variant="footnote" tone="secondary" numeric style={styles.status} accessibilityLiveRegion="polite">
        {formatStatus(status)}
      </Text>
      <ScrollView contentContainerStyle={[styles.controls, { paddingBottom: insets.bottom + spacing[6] }]}>
        <View style={styles.buttonRow}>
          <ActionButton
            label="Play script"
            onPress={playSelectedScript}
            disabled={running || FINGER_SCRIPTS.length === 0}
          />
          <ActionButton
            label={running || scriptPlaying ? 'Stop' : 'Play all variants'}
            prominent
            onPress={() => {
              if (running) dispatchAutoplay({ type: 'cancel' });
              else if (scriptPlaying) setScript(null);
              else startAutoplay(availableVariants.map((candidate) => candidate.id));
            }}
          />
        </View>
        <Section title="Variant">
          <OptionList options={variantOptions} selectedKey={variant.id} onSelect={selectVariant} label="Variant" />
          <Text variant="footnote" tone="secondary" style={styles.summary}>
            {variant.summary}
          </Text>
          {variant.boldParams ? (
            <SegmentedControl
              options={PRESET_OPTIONS}
              selectedKey={preset}
              onSelect={(key) => choosePreset(key === 'bold' ? 'bold' : 'subtle')}
              accessibilityLabel="Preset"
            />
          ) : null}
        </Section>
        <Section title="Speed">
          <SegmentedControl
            options={SPEED_OPTIONS}
            selectedKey={String(speed)}
            onSelect={(key) => setSpeed(Number(key) as SpeedChoice)}
            accessibilityLabel="Speed"
          />
        </Section>
        <Section title="Reduce Motion">
          <SegmentedControl
            options={REDUCE_MOTION_OPTIONS}
            selectedKey={reduceMotion}
            onSelect={(key) => setReduceMotion(key as ReduceMotionChoice)}
            accessibilityLabel="Reduce Motion"
          />
        </Section>
        {variant.params.length > 0 ? (
          <Section title="Parameters">
            <View style={[styles.params, { backgroundColor: systemColors.secondaryGroupedBackground }]}>
              {variant.params.map((spec) => (
                <ParamSlider
                  key={spec.key}
                  spec={spec}
                  value={params[spec.key] ?? spec.default}
                  onCommit={handleParamCommit}
                />
              ))}
            </View>
            <View style={styles.buttonRow}>
              <ActionButton label={copied ? 'Copied' : 'Copy params'} onPress={copyParams} />
              <ActionButton label="Reset params" onPress={() => choosePreset('subtle')} />
            </View>
          </Section>
        ) : null}
        {FINGER_SCRIPTS.length > 0 ? (
          <Section title="Script">
            <OptionList
              options={FINGER_SCRIPTS.map((candidate) => ({ key: candidate.id, label: candidate.label }))}
              selectedKey={scriptId}
              onSelect={setScriptId}
              label="Script"
            />
          </Section>
        ) : null}
        <Section title="Board">
          <OptionList
            options={LAB_BOARDS.map((candidate) => ({ key: candidate.id, label: candidate.label }))}
            selectedKey={board.id}
            onSelect={(key) => {
              setBoardId(key);
              setSetId('real');
            }}
            label="Board"
          />
        </Section>
        <Section title="Climb set">
          <OptionList
            options={climbSets.map((candidate) => ({ key: candidate.id, label: candidate.label }))}
            selectedKey={climbSet.id}
            onSelect={setSetId}
            label="Climb set"
          />
        </Section>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  caption: { paddingHorizontal: spacing[4], paddingBottom: spacing[3], gap: spacing[1] },
  status: { paddingHorizontal: spacing[4], paddingVertical: spacing[2], textAlign: 'center' },
  controls: { paddingHorizontal: spacing[4], gap: spacing[1] },
  buttonRow: { flexDirection: 'row', gap: spacing[3], paddingTop: spacing[2] },
  summary: { paddingHorizontal: spacing[1] },
  params: { borderRadius: borderRadius.lg, padding: spacing[4], gap: spacing[3] },
});
