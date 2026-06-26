import { useCallback, useId, useMemo, useRef, useState } from 'react';
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
const DEFAULT_OKHSL: Okhsl = { h: 0, s: 0, l: 0.5 };

function sampleGradient(count: number, at: (t: number) => string): { offset: number; color: string }[] {
  if (count <= 1) return [{ offset: 0, color: at(0) }];
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
  /** Keyboard / screen-reader step as a fraction of the full range. */
  step: number;
};

function ChannelSlider({
  label,
  valueText,
  accessibilityLabel,
  ratio,
  stops,
  onChangeRatio,
  step,
}: ChannelSliderProps) {
  const { systemColors } = useTheme();
  const gradientId = `okhsl-${useId().replace(/:/g, '_')}`;
  const trackRef = useRef<View>(null);
  const trackLayoutRef = useRef<{ pageLeft: number; width: number } | null>(null);
  const clamped = Math.max(0, Math.min(1, ratio));

  // Mirror the latest props into refs so the gesture handlers below can stay
  // stable (built once) instead of rebuilding the PanResponder mid-drag —
  // matches the MarkerMultiplierSlider pattern + the repo's RN perf rules.
  const onChangeRatioRef = useRef(onChangeRatio);
  onChangeRatioRef.current = onChangeRatio;
  const ratioRef = useRef(clamped);
  ratioRef.current = clamped;
  const stepRef = useRef(step);
  stepRef.current = step;

  const applyPageX = useCallback((pageX: number, layout: { pageLeft: number; width: number }) => {
    if (layout.width <= 0) return;
    onChangeRatioRef.current(Math.max(0, Math.min(1, (pageX - layout.pageLeft) / layout.width)));
  }, []);

  const measureAndApply = useCallback(
    (pageX: number) => {
      trackRef.current?.measure((_x, _y, width, _height, pageLeft) => {
        if (width <= 0) return;
        const layout = { pageLeft, width };
        trackLayoutRef.current = layout;
        applyPageX(pageX, layout);
      });
    },
    [applyPageX],
  );

  const setFromPageX = useCallback(
    (pageX: number) => {
      const layout = trackLayoutRef.current;
      if (layout) applyPageX(pageX, layout);
      else measureAndApply(pageX);
    },
    [applyPageX, measureAndApply],
  );

  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderGrant: (event: GestureResponderEvent) => measureAndApply(event.nativeEvent.pageX),
        onPanResponderMove: (_event, gestureState) => setFromPageX(gestureState.moveX),
      }),
    [measureAndApply, setFromPageX],
  );

  const handleAccessibilityAction = useCallback((event: { nativeEvent: { actionName: string } }) => {
    const delta = event.nativeEvent.actionName === 'increment' ? stepRef.current : -stepRef.current;
    onChangeRatioRef.current(Math.max(0, Math.min(1, ratioRef.current + delta)));
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
        <View
          ref={trackRef}
          onLayout={() => {
            trackLayoutRef.current = null;
          }}
          style={styles.trackContainer}
        >
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
}

type OkhslColorPickerProps = {
  /**
   * Initial colour as #rrggbb. Read only on mount — OKHSL is the source of
   * truth thereafter, so the caller re-seeds by remounting via a React `key`
   * (e.g. key per opened role) rather than pushing new values in.
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
  // Show the caller's literal hex when valid (the OKHSL round-trip can be ±1 off).
  const [hexDraft, setHexDraft] = useState<string>(
    () => normalizeHexColor(value) ?? okhslToHex(hexToOkhsl(value) ?? DEFAULT_OKHSL),
  );

  const commit = useCallback(
    (next: Okhsl) => {
      setOkhsl(next);
      const hex = okhslToHex(next);
      setHexDraft(hex);
      onChange(hex);
    },
    [onChange],
  );

  const lightnessStops = useMemo(
    () => sampleGradient(SL_STOPS, (t) => okhslToHex({ h: okhsl.h, s: okhsl.s, l: t })),
    [okhsl.h, okhsl.s],
  );
  const saturationStops = useMemo(
    () => sampleGradient(SL_STOPS, (t) => okhslToHex({ h: okhsl.h, s: t, l: okhsl.l })),
    [okhsl.h, okhsl.l],
  );
  const hueStops = useMemo(
    () => sampleGradient(HUE_STOPS, (t) => okhslToHex({ h: t * 360, s: okhsl.s, l: okhsl.l })),
    [okhsl.s, okhsl.l],
  );

  const handleHexChange = useCallback(
    (text: string) => {
      setHexDraft(text);
      const normalized = normalizeHexColor(text);
      if (normalized) {
        const parsed = hexToOkhsl(normalized);
        if (parsed) {
          setOkhsl(parsed);
          onChange(normalized);
        }
      }
    },
    [onChange],
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
        onChangeRatio={(ratio) => commit({ ...okhsl, l: ratio })}
      />
      <ChannelSlider
        label={t('mobile.more.accessibility.sliders.saturation')}
        valueText={`${Math.round(okhsl.s * 100)}%`}
        accessibilityLabel={t('mobile.more.accessibility.sliders.saturation')}
        ratio={okhsl.s}
        stops={saturationStops}
        step={0.05}
        onChangeRatio={(ratio) => commit({ ...okhsl, s: ratio })}
      />
      <ChannelSlider
        label={t('mobile.more.accessibility.sliders.hue')}
        valueText={`${Math.round(okhsl.h)}°`}
        accessibilityLabel={t('mobile.more.accessibility.sliders.hue')}
        ratio={okhsl.h / 360}
        stops={hueStops}
        step={1 / 36}
        onChangeRatio={(ratio) => commit({ ...okhsl, h: ratio * 360 })}
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
