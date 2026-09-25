// Rest length as a pill you tap and a slider you scrub — the same `ValuePill` +
// `ValueSlider` pair the play drawer's cadence uses, pointed at the other number
// a climber changes mid-session.
//
// It replaces a 27-chip rail. The rail made every length one tap in theory, but
// on a 393pt screen it showed `Off · 0:15 · 0:30 · 0:45 · 1:00 · 1:15` and put
// 2:00 and 3:00 behind a horizontal scroll — so the rests people actually take
// got HARDER to reach than the segmented control the rail replaced. Here the
// common range is a tap away (30 s a press, wrapping past 10:00 back to `Off`)
// and everything up to an hour is one long-press and a drag.
//
// What is rest-specific, and so lives here rather than in the shared control:
// `Off`. It is a mode, not a duration, so it is not a position on the slider —
// the tap-wrap owns it, and a cancelled drag has to be restored by this file
// because the slider has no way to express it.

import { useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated';
import { useTranslation } from 'react-i18next';
import { ValuePill } from '../ValuePill';
import { ValueSlider } from '../ValueSlider';
import { MIN_NOTCH_TRAVEL_PX } from '../value-slider.logic';
import { useReduceMotion } from '../../hooks/use-reduce-motion';
import { hapticLight, hapticSelection } from '../../lib/haptics';
import { timing } from '../../theme/animations';
import { spacing } from '../../theme/tokens';
import {
  MAX_REST_LENGTH_SECONDS,
  MIN_REST_LENGTH_SECONDS,
  adjustRestLength,
  formatRestLength,
  hasRestLength,
  magnetRestLength,
  nextRestLength,
  quantizeRestLength,
  restLengthNotch,
  restRatioForSeconds,
  restSecondsAtRatio,
  sliderRestLength,
} from './rest-length.logic';

/** Width floor for the pill, sized to the longest rest it can show ("1:00:00"). */
const REST_PILL_MIN_WIDTH = 88;

type RestLengthPickerProps = {
  /** The persisted rest length in seconds; `null` is `Off`. */
  value: number | null;
  onChange: (nextSeconds: number | null) => void;
};

/**
 * The rest-length control: one pill, and the slider it reveals.
 *
 * An arbitrary persisted rest (someone's 100 s from the old stepper) is shown as
 * it is, opens the slider where it is, and is never rewritten until the climber
 * moves it themselves — silently rounding a persisted setting because the UI was
 * redesigned underneath it is the one thing this control must not do.
 */
export function RestLengthPicker({ value, onChange }: RestLengthPickerProps) {
  const { t } = useTranslation('session');
  const reduceMotion = useReduceMotion();
  const [expanded, setExpanded] = useState(false);
  // The pill reads the live value while a drag is in flight, the committed one
  // otherwise. `null` is `Off`, which only the committed value can be.
  const [liveValue, setLiveValue] = useState<number | null>(value);
  useEffect(() => {
    setLiveValue(value);
  }, [value]);

  // Read by the cancel path, which needs today's committed value without the
  // slider listing it in the gesture's deps (that would rebuild the gesture on
  // every commit the slider itself makes).
  const committedRef = useRef(value);
  committedRef.current = value;
  const handleCancel = useCallback(() => setLiveValue(committedRef.current), []);

  const handleStep = useCallback(() => {
    hapticSelection();
    onChange(nextRestLength(value));
  }, [onChange, value]);

  const handleToggleSlider = useCallback(() => {
    hapticLight();
    setExpanded((open) => !open);
  }, []);

  const label = hasRestLength(liveValue) ? formatRestLength(liveValue) : t('mobile.restTimer.off');

  return (
    <View>
      <View style={styles.pillRow}>
        <ValuePill
          label={label}
          active={expanded}
          minWidth={REST_PILL_MIN_WIDTH}
          reduceMotion={reduceMotion}
          onCycle={handleStep}
          onToggleSlider={handleToggleSlider}
          accessibilityLabel={t('mobile.restTimer.lengthPillAria', { value: label })}
          accessibilityHint={t('mobile.restTimer.lengthPillHint')}
          testID="rest-length-pill"
        />
      </View>

      {expanded ? (
        <Animated.View
          entering={reduceMotion ? undefined : FadeIn.duration(timing.fast)}
          exiting={reduceMotion ? undefined : FadeOut.duration(timing.instant)}
          style={styles.sliderRow}
        >
          <ValueSlider
            value={sliderRestLength(value)}
            min={MIN_REST_LENGTH_SECONDS}
            max={MAX_REST_LENGTH_SECONDS}
            ratioToValue={restSecondsAtRatio}
            valueToRatio={restRatioForSeconds}
            round={quantizeRestLength}
            notch={restLengthNotch}
            // The far end of this track is worth ~30 s a pixel, where a flick
            // would otherwise fire a haptic on every frame.
            minNotchTravelPx={MIN_NOTCH_TRAVEL_PX}
            magnet={magnetRestLength}
            format={formatRestLength}
            accessibilityLabel={t('mobile.restTimer.targetAria')}
            adjust={adjustRestLength}
            reduceMotion={reduceMotion}
            onLiveChange={setLiveValue}
            onCommit={onChange}
            onCancel={handleCancel}
            testID="rest-length-slider"
          />
        </Animated.View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  // The row owns no horizontal padding: the gutter belongs to the block that
  // mounts this (tick-sheet-metrics' two-seam rule).
  pillRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  sliderRow: {
    paddingTop: spacing[2],
  },
});
