import { memo, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  PanResponder,
  StyleSheet,
  View,
  type GestureResponderEvent,
  type StyleProp,
  type TextStyle,
} from 'react-native';
import { BottomSheetTextInput } from '@expo/ui/community/bottom-sheet';
import { useTranslation } from 'react-i18next';
import Svg, { Defs, LinearGradient, Rect, Stop } from 'react-native-svg';
import { Text } from '../Text';
import { useTheme } from '../../providers/theme-provider';
import { iosSystemColors } from '../../theme/ios-colors';
import { hexToOkhsl, okhslToHex, type Okhsl } from '../../lib/okhsl';
import { normalizeHexColor } from '../../lib/hold-color-overrides';
import { borderRadius, spacing } from '../../theme/tokens';

// Destructive red for the invalid-hex state (matches AuthTextInput's error
// border) — the accent token reads as a focused/selected field, not an error.
const ERROR_COLOR = iosSystemColors.systemRed;

const HUE_STOPS = 13;
const SL_STOPS = 12;
const GRADIENT_UPDATE_INTERVAL_MS = 1000 / 30;
const DEFAULT_OKHSL: Okhsl = { h: 0, s: 0, l: 0.5 };

function sampleGradient(count: number, at: (t: number) => string): { offset: number; color: string }[] {
  if (count <= 0) return [];
  if (count === 1) return [{ offset: 0, color: at(0) }];
  const stops: { offset: number; color: string }[] = [];
  for (let i = 0; i < count; i += 1) {
    const t = i / (count - 1);
    stops.push({ offset: t, color: at(t) });
  }
  return stops;
}

type ChannelSliderProps = {
  label: string;
  valueText: string;
  accessibilityLabel: string;
  /** Thumb position, 0–1. */
  ratio: number;
  stops: { offset: number; color: string }[];
  onChangeRatio: (ratio: number) => void;
  /** Mutable epoch shared by all three sliders to invalidate stale gestures. */
  gestureEpochRef: { current: number };
  onDragStart: () => number;
  onDragEnd: (gestureEpoch: number) => void;
  /** Keyboard / screen-reader step as a fraction of the full range. */
  step: number;
};

type PendingSliderCoordinate = {
  gestureGeneration: number;
  pickerGestureEpoch: number;
  pageX: number;
  shouldEndGesture: boolean;
};

const ChannelSlider = memo(function ChannelSlider({
  label,
  valueText,
  accessibilityLabel,
  ratio,
  stops,
  onChangeRatio,
  gestureEpochRef,
  onDragStart,
  onDragEnd,
  step,
}: ChannelSliderProps) {
  const { systemColors } = useTheme();
  const gradientId = `okhsl-${useId().replace(/:/g, '_')}`;
  const trackRef = useRef<View>(null);
  const trackLayoutRef = useRef<{ pageLeft: number; width: number } | null>(null);
  const mountedRef = useRef(true);
  const gestureGenerationRef = useRef(0);
  const activePickerGestureEpochRef = useRef(-1);
  const finishedGestureGenerationRef = useRef(-1);
  const layoutGenerationRef = useRef(0);
  const measurementInFlightRef = useRef(false);
  const pendingCoordinateRef = useRef<PendingSliderCoordinate | null>(null);
  const measurePendingCoordinateRef = useRef<() => void>(() => undefined);
  const clamped = Math.max(0, Math.min(1, ratio));

  // Mirror the latest props into refs so the gesture handlers below can stay
  // stable (built once) instead of rebuilding the PanResponder mid-drag —
  // matches the MarkerMultiplierSlider pattern + the repo's RN perf rules.
  const onChangeRatioRef = useRef(onChangeRatio);
  onChangeRatioRef.current = onChangeRatio;
  const onDragStartRef = useRef(onDragStart);
  onDragStartRef.current = onDragStart;
  const onDragEndRef = useRef(onDragEnd);
  onDragEndRef.current = onDragEnd;
  const ratioRef = useRef(clamped);
  ratioRef.current = clamped;
  const stepRef = useRef(step);
  stepRef.current = step;

  const applyPageX = useCallback((pageX: number, layout: { pageLeft: number; width: number }) => {
    if (layout.width <= 0) return;
    onChangeRatioRef.current(Math.max(0, Math.min(1, (pageX - layout.pageLeft) / layout.width)));
  }, []);

  const finishGesture = useCallback(
    (gestureGeneration: number, pickerGestureEpoch: number) => {
      if (
        !mountedRef.current ||
        gestureGeneration !== gestureGenerationRef.current ||
        pickerGestureEpoch !== gestureEpochRef.current ||
        finishedGestureGenerationRef.current === gestureGeneration
      ) {
        return;
      }

      finishedGestureGenerationRef.current = gestureGeneration;
      onDragEndRef.current(pickerGestureEpoch);
    },
    [gestureEpochRef],
  );

  const applyCoordinate = useCallback(
    (coordinate: PendingSliderCoordinate, layout: { pageLeft: number; width: number }) => {
      if (
        !mountedRef.current ||
        coordinate.gestureGeneration !== gestureGenerationRef.current ||
        coordinate.pickerGestureEpoch !== gestureEpochRef.current ||
        finishedGestureGenerationRef.current === coordinate.gestureGeneration
      ) {
        return;
      }

      applyPageX(coordinate.pageX, layout);
      if (coordinate.shouldEndGesture) {
        finishGesture(coordinate.gestureGeneration, coordinate.pickerGestureEpoch);
      }
    },
    [applyPageX, finishGesture, gestureEpochRef],
  );

  const measurePendingCoordinate = useCallback(() => {
    const coordinate = pendingCoordinateRef.current;
    const track = trackRef.current;
    if (!mountedRef.current || !coordinate || !track || measurementInFlightRef.current) return;

    const measuredGestureGeneration = coordinate.gestureGeneration;
    const measuredLayoutGeneration = layoutGenerationRef.current;
    measurementInFlightRef.current = true;
    track.measure((_x, _y, width, _height, pageLeft) => {
      measurementInFlightRef.current = false;
      if (!mountedRef.current) return;

      if (
        measuredGestureGeneration !== gestureGenerationRef.current ||
        measuredLayoutGeneration !== layoutGenerationRef.current
      ) {
        measurePendingCoordinateRef.current();
        return;
      }

      const latestCoordinate = pendingCoordinateRef.current;
      if (!latestCoordinate || latestCoordinate.gestureGeneration !== measuredGestureGeneration) {
        measurePendingCoordinateRef.current();
        return;
      }

      pendingCoordinateRef.current = null;
      if (width <= 0) {
        if (latestCoordinate.shouldEndGesture) {
          finishGesture(latestCoordinate.gestureGeneration, latestCoordinate.pickerGestureEpoch);
        }
        return;
      }

      const layout = { pageLeft, width };
      trackLayoutRef.current = layout;
      applyCoordinate(latestCoordinate, layout);
    });
  }, [applyCoordinate, finishGesture]);
  useEffect(() => {
    // Keep the latest callback available to its own deferred measurement
    // completions without rebuilding the gesture responder mid-drag.
    measurePendingCoordinateRef.current = measurePendingCoordinate;
    return () => {
      measurePendingCoordinateRef.current = () => undefined;
    };
  }, [measurePendingCoordinate]);

  const requestCoordinate = useCallback(
    (pageX: number, shouldEndGesture: boolean) => {
      if (!mountedRef.current) return;

      const gestureGeneration = gestureGenerationRef.current;
      const pickerGestureEpoch = activePickerGestureEpochRef.current;
      if (pickerGestureEpoch !== gestureEpochRef.current) return;
      if (finishedGestureGenerationRef.current === gestureGeneration) return;

      const pendingCoordinate = pendingCoordinateRef.current;
      const coordinate = {
        gestureGeneration,
        pickerGestureEpoch,
        pageX,
        shouldEndGesture:
          shouldEndGesture ||
          (pendingCoordinate?.gestureGeneration === gestureGeneration && pendingCoordinate.shouldEndGesture),
      };
      const layout = trackLayoutRef.current;
      if (layout) {
        pendingCoordinateRef.current = null;
        applyCoordinate(coordinate, layout);
        return;
      }

      pendingCoordinateRef.current = coordinate;
      measurePendingCoordinateRef.current();
    },
    [applyCoordinate, gestureEpochRef],
  );

  useEffect(() => {
    // React Strict Mode replays effect cleanup + setup without recreating refs,
    // so restore the mounted flag after its development-only cleanup pass.
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      gestureGenerationRef.current += 1;
      activePickerGestureEpochRef.current = -1;
      measurementInFlightRef.current = false;
      pendingCoordinateRef.current = null;
    };
  }, []);

  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderGrant: (event: GestureResponderEvent) => {
          if (!mountedRef.current) return;
          gestureGenerationRef.current += 1;
          pendingCoordinateRef.current = null;
          activePickerGestureEpochRef.current = onDragStartRef.current();
          requestCoordinate(event.nativeEvent.pageX, false);
        },
        onPanResponderMove: (_event, gestureState) => requestCoordinate(gestureState.moveX, false),
        onPanResponderRelease: (event: GestureResponderEvent) => {
          requestCoordinate(event.nativeEvent.pageX, true);
        },
        onPanResponderTerminate: (event: GestureResponderEvent) => {
          requestCoordinate(event.nativeEvent.pageX, true);
        },
      }),
    [requestCoordinate],
  );

  const handleAccessibilityAction = useCallback((event: { nativeEvent: { actionName: string } }) => {
    const delta = event.nativeEvent.actionName === 'increment' ? stepRef.current : -stepRef.current;
    onChangeRatioRef.current(Math.max(0, Math.min(1, ratioRef.current + delta)));
  }, []);

  const handleTrackLayout = useCallback(() => {
    layoutGenerationRef.current += 1;
    trackLayoutRef.current = null;
    measurePendingCoordinateRef.current();
  }, []);

  return (
    <View style={styles.sliderBlock}>
      <View style={styles.sliderLabelRow}>
        <Text variant="subheadline" color={systemColors.label}>
          {label}
        </Text>
        <Text variant="subheadline" color={systemColors.secondaryLabel}>
          {valueText}
        </Text>
      </View>
      <View
        accessible
        accessibilityRole="adjustable"
        accessibilityLabel={accessibilityLabel}
        accessibilityValue={{ text: valueText }}
        accessibilityActions={ACCESSIBILITY_ACTIONS}
        onAccessibilityAction={handleAccessibilityAction}
        style={styles.sliderTouchArea}
        {...panResponder.panHandlers}
      >
        <View ref={trackRef} onLayout={handleTrackLayout} style={styles.trackContainer}>
          <Svg width="100%" height={TRACK_HEIGHT} style={styles.trackSvg}>
            <Defs>
              <LinearGradient id={gradientId} x1="0" y1="0" x2="1" y2="0">
                {stops.map((stop) => (
                  <Stop key={stop.offset} offset={stop.offset} stopColor={stop.color} />
                ))}
              </LinearGradient>
            </Defs>
            <Rect
              x={0}
              y={0}
              width="100%"
              height={TRACK_HEIGHT}
              rx={TRACK_HEIGHT / 2}
              ry={TRACK_HEIGHT / 2}
              fill={`url(#${gradientId})`}
            />
          </Svg>
          <View
            style={[
              styles.thumb,
              {
                borderColor: systemColors.background,
                left: `${clamped * 100}%`,
              },
            ]}
          />
        </View>
      </View>
    </View>
  );
});

function useGradientSnapshot(initialOkhsl: Okhsl) {
  const [gradientOkhsl, setGradientOkhsl] = useState(initialOkhsl);
  const latestOkhslRef = useRef(initialOkhsl);
  const gestureEpochRef = useRef(0);
  const dragActiveRef = useRef(false);
  const lastGradientUpdateAtRef = useRef(0);
  const pendingGradientUpdateRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancelPendingGradientUpdate = useCallback(() => {
    if (pendingGradientUpdateRef.current === null) return;
    clearTimeout(pendingGradientUpdateRef.current);
    pendingGradientUpdateRef.current = null;
  }, []);

  const applyGradientSnapshot = useCallback(
    (nextOkhsl: Okhsl) => {
      cancelPendingGradientUpdate();
      lastGradientUpdateAtRef.current = Date.now();
      setGradientOkhsl(nextOkhsl);
    },
    [cancelPendingGradientUpdate],
  );

  const updateGradientSnapshot = useCallback(
    (nextOkhsl: Okhsl) => {
      latestOkhslRef.current = nextOkhsl;
      if (!dragActiveRef.current) {
        applyGradientSnapshot(nextOkhsl);
        return;
      }

      const elapsedMs = Math.max(0, Date.now() - lastGradientUpdateAtRef.current);
      if (elapsedMs >= GRADIENT_UPDATE_INTERVAL_MS) {
        applyGradientSnapshot(nextOkhsl);
        return;
      }

      if (pendingGradientUpdateRef.current !== null) return;
      pendingGradientUpdateRef.current = setTimeout(() => {
        pendingGradientUpdateRef.current = null;
        lastGradientUpdateAtRef.current = Date.now();
        setGradientOkhsl(latestOkhslRef.current);
      }, GRADIENT_UPDATE_INTERVAL_MS - elapsedMs);
    },
    [applyGradientSnapshot],
  );

  const beginGradientDrag = useCallback(() => {
    gestureEpochRef.current += 1;
    cancelPendingGradientUpdate();
    dragActiveRef.current = true;
    lastGradientUpdateAtRef.current = Date.now();
    setGradientOkhsl(latestOkhslRef.current);
    return gestureEpochRef.current;
  }, [cancelPendingGradientUpdate]);

  const finishGradientDrag = useCallback(
    (gestureEpoch: number) => {
      if (gestureEpoch !== gestureEpochRef.current) return;
      dragActiveRef.current = false;
      applyGradientSnapshot(latestOkhslRef.current);
    },
    [applyGradientSnapshot],
  );

  useEffect(
    () => () => {
      gestureEpochRef.current += 1;
      dragActiveRef.current = false;
      cancelPendingGradientUpdate();
    },
    [cancelPendingGradientUpdate],
  );

  return { gradientOkhsl, gestureEpochRef, updateGradientSnapshot, beginGradientDrag, finishGradientDrag };
}

type OkhslColorPickerProps = {
  /**
   * Initial colour as #rrggbb. Read only on mount — OKHSL is the source of
   * truth thereafter, so the caller re-seeds by remounting via a React `key`
   * (e.g. key per opened role) rather than pushing new values in. This also
   * makes a parent prop change during an active drag intentionally inert.
   */
  value: string;
  onChange: (hex: string) => void;
};

/**
 * Lightness-first OKHSL colour picker, tuned for colour-blind users:
 * Lightness (the channel CVD users perceive most reliably) leads, then
 * Saturation, then Hue. Each slider's track is a real OKHSL gradient, and
 * each is an accessibilityRole="adjustable" for VoiceOver/TalkBack. A hex
 * field below allows precise manual entry. OKHSL is the source of truth so
 * dragging never drifts from hex round-tripping.
 */
export function OkhslColorPicker({ value, onChange }: OkhslColorPickerProps) {
  const { t } = useTranslation('common');
  const { systemColors } = useTheme();
  const [okhsl, setOkhsl] = useState<Okhsl>(() => hexToOkhsl(value) ?? DEFAULT_OKHSL);
  const latestOkhslRef = useRef(okhsl);
  const { gradientOkhsl, gestureEpochRef, updateGradientSnapshot, beginGradientDrag, finishGradientDrag } =
    useGradientSnapshot(okhsl);
  // Show the caller's literal hex when valid (the OKHSL round-trip can be ±1 off).
  const [hexDraft, setHexDraft] = useState<string>(
    () => normalizeHexColor(value) ?? okhslToHex(hexToOkhsl(value) ?? DEFAULT_OKHSL),
  );

  const applyOkhsl = useCallback(
    (next: Okhsl) => {
      latestOkhslRef.current = next;
      setOkhsl(next);
      updateGradientSnapshot(next);
    },
    [updateGradientSnapshot],
  );

  const commit = useCallback(
    (next: Okhsl) => {
      applyOkhsl(next);
      const hex = okhslToHex(next);
      setHexDraft(hex);
      onChange(hex);
    },
    [applyOkhsl, onChange],
  );

  const lightnessStops = useMemo(
    () => sampleGradient(SL_STOPS, (t) => okhslToHex({ h: gradientOkhsl.h, s: gradientOkhsl.s, l: t })),
    [gradientOkhsl.h, gradientOkhsl.s],
  );
  const saturationStops = useMemo(
    () => sampleGradient(SL_STOPS, (t) => okhslToHex({ h: gradientOkhsl.h, s: t, l: gradientOkhsl.l })),
    [gradientOkhsl.h, gradientOkhsl.l],
  );
  const hueStops = useMemo(
    () => sampleGradient(HUE_STOPS, (t) => okhslToHex({ h: t * 360, s: gradientOkhsl.s, l: gradientOkhsl.l })),
    [gradientOkhsl.s, gradientOkhsl.l],
  );

  const handleLightnessChange = useCallback(
    (ratio: number) => commit({ ...latestOkhslRef.current, l: ratio }),
    [commit],
  );
  const handleSaturationChange = useCallback(
    (ratio: number) => commit({ ...latestOkhslRef.current, s: ratio }),
    [commit],
  );
  const handleHueChange = useCallback(
    (ratio: number) => commit({ ...latestOkhslRef.current, h: ratio * 360 }),
    [commit],
  );

  const handleHexChange = useCallback(
    (text: string) => {
      setHexDraft(text);
      const normalized = normalizeHexColor(text);
      if (normalized) {
        const parsed = hexToOkhsl(normalized);
        if (parsed) {
          applyOkhsl(parsed);
          onChange(normalized);
        }
      }
    },
    [applyOkhsl, onChange],
  );

  const hexValid = normalizeHexColor(hexDraft) !== null;

  const hexInputStyle: StyleProp<TextStyle> = [
    styles.hexInput,
    {
      backgroundColor: systemColors.fill,
      color: systemColors.label,
      borderColor: hexValid ? systemColors.separator : ERROR_COLOR,
    },
  ];

  return (
    <View style={styles.container}>
      <ChannelSlider
        label={t('mobile.more.accessibility.sliders.lightness')}
        valueText={`${Math.round(okhsl.l * 100)}%`}
        accessibilityLabel={t('mobile.more.accessibility.sliders.lightness')}
        ratio={okhsl.l}
        stops={lightnessStops}
        step={0.05}
        onChangeRatio={handleLightnessChange}
        gestureEpochRef={gestureEpochRef}
        onDragStart={beginGradientDrag}
        onDragEnd={finishGradientDrag}
      />
      <ChannelSlider
        label={t('mobile.more.accessibility.sliders.saturation')}
        valueText={`${Math.round(okhsl.s * 100)}%`}
        accessibilityLabel={t('mobile.more.accessibility.sliders.saturation')}
        ratio={okhsl.s}
        stops={saturationStops}
        step={0.05}
        onChangeRatio={handleSaturationChange}
        gestureEpochRef={gestureEpochRef}
        onDragStart={beginGradientDrag}
        onDragEnd={finishGradientDrag}
      />
      <ChannelSlider
        label={t('mobile.more.accessibility.sliders.hue')}
        valueText={`${Math.round(okhsl.h)}°`}
        accessibilityLabel={t('mobile.more.accessibility.sliders.hue')}
        ratio={okhsl.h / 360}
        stops={hueStops}
        step={1 / 36}
        onChangeRatio={handleHueChange}
        gestureEpochRef={gestureEpochRef}
        onDragStart={beginGradientDrag}
        onDragEnd={finishGradientDrag}
      />
      <View style={styles.hexRow}>
        <Text variant="subheadline" color={systemColors.secondaryLabel}>
          {t('mobile.more.accessibility.hexLabel')}
        </Text>
        <BottomSheetTextInput
          value={hexDraft}
          onChangeText={handleHexChange}
          autoCapitalize="none"
          autoCorrect={false}
          maxLength={7}
          returnKeyType="done"
          accessibilityLabel={t('mobile.more.accessibility.hexLabel')}
          accessibilityHint={hexValid ? undefined : t('mobile.more.accessibility.invalidHex')}
          style={hexInputStyle}
        />
      </View>
      {hexValid ? null : (
        <Text variant="footnote" color={ERROR_COLOR}>
          {t('mobile.more.accessibility.invalidHex')}
        </Text>
      )}
    </View>
  );
}

const TRACK_HEIGHT = 14;
const ACCESSIBILITY_ACTIONS = [{ name: 'increment' }, { name: 'decrement' }] as const;

const styles = StyleSheet.create({
  container: {
    gap: spacing[4],
  },
  sliderBlock: {
    gap: spacing[2],
  },
  sliderLabelRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  sliderTouchArea: {
    paddingVertical: spacing[2],
  },
  trackContainer: {
    height: TRACK_HEIGHT,
    justifyContent: 'center',
  },
  trackSvg: {
    borderRadius: TRACK_HEIGHT / 2,
  },
  thumb: {
    position: 'absolute',
    top: -5,
    width: TRACK_HEIGHT + 10,
    height: TRACK_HEIGHT + 10,
    marginLeft: -(TRACK_HEIGHT + 10) / 2,
    borderRadius: (TRACK_HEIGHT + 10) / 2,
    borderWidth: 3,
    backgroundColor: 'transparent',
  },
  hexRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing[3],
  },
  hexInput: {
    minWidth: 120,
    minHeight: 44,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: borderRadius.md,
    paddingHorizontal: spacing[3],
    textAlign: 'center',
    fontSize: 17,
    fontWeight: '600',
  },
});
