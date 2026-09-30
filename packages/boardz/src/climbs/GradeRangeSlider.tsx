import { useRef, useState, type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import * as Haptics from 'expo-haptics';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { bandColor, gradeBandFromId, type GradeOption } from '../grades/grades';
import { Text } from '../ui/Text';
import { useTheme } from '../ui/theme';
import { GUTTER } from '../ui/tokens';
import {
  bandStarts,
  gradeStops,
  moveThumb,
  rangeFromStops,
  stopRange,
  thumbFor,
  type GradeRange,
  type StopRange,
  type Thumb,
} from './grade-range';

const THUMB = 28;
const TRACK = 4;
const TOUCH_HEIGHT = 40;
const TICK_WIDTH = 32;

type GradeRangeSliderProps = GradeRange & {
  /** The board's grades, easiest first. */
  grades: readonly GradeOption[];
  onChange: (range: GradeRange) => void;
};

/**
 * The board's grade scale with a thumb at each end of the range. Drag a thumb,
 * or tap the scale to bring the nearer thumb there. The filter changes when the
 * finger lifts, so a drag doesn't search at every grade it passes.
 */
export function GradeRangeSlider({ grades, minGrade, maxGrade, onChange }: GradeRangeSliderProps) {
  const theme = useTheme();
  const stops = gradeStops(grades);
  const last = stops.length - 1;
  const committed = stopRange(stops, { minGrade, maxGrade });
  // Where the thumbs are while a finger is down; null when they show the filter.
  const [draft, setDraft] = useState<StopRange | null>(null);
  const shown = draft ?? committed;
  const [width, setWidth] = useState(0);
  // The gesture callbacks work from this, not from state, which lags a render behind.
  const drag = useRef<{ thumb: Thumb; range: StopRange } | null>(null);

  const step = last > 0 ? (width - THUMB) / last : 0;
  const xOf = (index: number) => THUMB / 2 + index * step;
  const indexAt = (x: number) => (step > 0 ? Math.min(last, Math.max(0, Math.round((x - THUMB / 2) / step))) : 0);
  const colorOf = (index: number) =>
    bandColor(theme.grades, gradeBandFromId(stops[index]?.difficultyIds[0])) ?? theme.fg1;

  const moveTo = (index: number) => {
    const current = drag.current;
    if (!current) return;
    const next = moveThumb(current.range, current.thumb, index);
    if (next.min === current.range.min && next.max === current.range.max) return;
    current.range = next;
    setDraft(next);
    void Haptics.selectionAsync();
  };
  const release = () => {
    const current = drag.current;
    drag.current = null;
    setDraft(null);
    if (current && (current.range.min !== committed.min || current.range.max !== committed.max)) {
      onChange(rangeFromStops(stops, current.range));
    }
  };
  const nudge = (thumb: Thumb, by: number) => {
    const index = (thumb === 'min' ? committed.min : committed.max) + by;
    if (index < 0 || index > last) return;
    onChange(rangeFromStops(stops, moveThumb(committed, thumb, index)));
  };

  const pan = Gesture.Pan()
    .runOnJS(true)
    .activeOffsetX([-4, 4])
    .failOffsetY([-10, 10])
    .onStart(({ x, translationX }) => {
      drag.current = { thumb: thumbFor(committed, indexAt(x - translationX), translationX), range: committed };
      moveTo(indexAt(x));
    })
    .onUpdate(({ x }) => moveTo(indexAt(x)))
    .onFinalize(release);
  const tap = Gesture.Tap()
    .runOnJS(true)
    .maxDistance(8)
    .onEnd(({ x }) => {
      drag.current = { thumb: thumbFor(committed, indexAt(x), 0), range: committed };
      moveTo(indexAt(x));
      release();
    });

  // The stretch between the thumbs, coloured band by band, changing colour halfway between grades.
  const segments: { from: number; to: number; color: string }[] = [];
  if (width > 0) {
    let start = shown.min;
    for (let index = shown.min + 1; index <= shown.max + 1; index += 1) {
      if (index <= shown.max && colorOf(index) === colorOf(start)) continue;
      const from = start === shown.min ? xOf(start) : xOf(start) - step / 2;
      const to = index > shown.max ? xOf(shown.max) : xOf(index) - step / 2;
      if (to > from) segments.push({ from, to, color: colorOf(start) });
      start = index;
    }
  }

  const grade = (index: number) => (
    <Text variant="grade" color={colorOf(index)}>
      {stops[index]?.label}
    </Text>
  );
  let readout: ReactNode;
  if (shown.min === shown.max) readout = grade(shown.min);
  else if (shown.min === 0 && shown.max === last) readout = 'All grades';
  else if (shown.min === 0) readout = <>Up to {grade(shown.max)}</>;
  else if (shown.max === last) readout = <>{grade(shown.min)} and up</>;
  else
    readout = (
      <>
        {grade(shown.min)} – {grade(shown.max)}
      </>
    );

  const thumb = (which: Thumb) => {
    const index = which === 'min' ? shown.min : shown.max;
    const open = which === 'min' ? index === 0 : index === last;
    return (
      <View
        key={which}
        accessible
        accessibilityRole="adjustable"
        accessibilityLabel={which === 'min' ? 'Easiest grade' : 'Hardest grade'}
        accessibilityValue={{ text: open ? 'No limit' : (stops[index]?.label ?? '') }}
        accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
        onAccessibilityAction={({ nativeEvent }) => nudge(which, nativeEvent.actionName === 'increment' ? 1 : -1)}
        style={[
          styles.thumb,
          { left: xOf(index) - THUMB / 2, backgroundColor: theme.bgSurface, borderColor: theme.borderStrong },
        ]}
      >
        <View style={[styles.led, { backgroundColor: colorOf(index) }]} />
      </View>
    );
  };

  return (
    <View style={styles.wrap}>
      <View style={styles.header}>
        <Text variant="label">Grades</Text>
        <Text variant="grade" tone="secondary" numberOfLines={1}>
          {readout}
        </Text>
      </View>
      <GestureDetector gesture={Gesture.Race(pan, tap)}>
        <View style={styles.touch} onLayout={(event) => setWidth(event.nativeEvent.layout.width)}>
          <View style={[styles.track, { left: THUMB / 2, right: THUMB / 2, backgroundColor: theme.border2 }]} />
          {segments.map((segment) => (
            <View
              key={segment.from}
              style={[
                styles.track,
                { left: segment.from, width: segment.to - segment.from, backgroundColor: segment.color },
              ]}
            />
          ))}
          {width > 0 ? [thumb('min'), thumb('max')] : null}
        </View>
      </GestureDetector>
      <View style={styles.ticks} importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
        {width > 0
          ? bandStarts(stops).map((index) => (
              <Text
                key={index}
                variant="mono"
                align="center"
                color={theme.fg3}
                style={[styles.tick, { left: Math.min(width - TICK_WIDTH, Math.max(0, xOf(index) - TICK_WIDTH / 2)) }]}
              >
                {stops[index].label}
              </Text>
            ))
          : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { paddingHorizontal: GUTTER, gap: 2 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', height: 18 },
  touch: { height: TOUCH_HEIGHT },
  track: { position: 'absolute', top: (TOUCH_HEIGHT - TRACK) / 2, height: TRACK, borderRadius: TRACK / 2 },
  thumb: {
    position: 'absolute',
    top: (TOUCH_HEIGHT - THUMB) / 2,
    width: THUMB,
    height: THUMB,
    borderRadius: THUMB / 2,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  led: { width: 10, height: 10, borderRadius: 5 },
  ticks: { height: 12 },
  tick: { position: 'absolute', width: TICK_WIDTH, fontSize: 10, lineHeight: 12 },
});
