import React, { useMemo } from 'react';
import { View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { runOnJS } from 'react-native-reanimated';

type HoldTargetProps = {
  holdId: number;
  leftPct: number;
  topPct: number;
  tapDiameter: number;
  /** Diameter of the faint discoverability dot, in device px. */
  dotDiameter: number;
  showDot: boolean;
  dotColor: string;
  onPaint: (holdId: number) => void;
  onLongPress: (holdId: number) => void;
};

/**
 * One hold's transparent tap target plus an optional discoverability dot. A
 * `GestureDetector` (not Pressable) is used so the per-hold tap/long-press
 * compose cleanly with the board's ancestor pinch/pan gestures. A quick
 * stationary touch paints; a 400ms press opens the role sheet; a drag falls
 * through to the pan gesture (the Tap fails on movement > maxDistance).
 *
 * `React.memo` leaf with primitive props — the static tap layer never
 * re-renders when holds are painted.
 */
export const HoldTarget = React.memo(function HoldTarget({
  holdId,
  leftPct,
  topPct,
  tapDiameter,
  dotDiameter,
  showDot,
  dotColor,
  onPaint,
  onLongPress,
}: HoldTargetProps) {
  const gesture = useMemo(() => {
    const tap = Gesture.Tap()
      .maxDuration(300)
      .maxDistance(15)
      .onStart(() => {
        'worklet';
        runOnJS(onPaint)(holdId);
      });
    const longPress = Gesture.LongPress()
      .minDuration(400)
      .onStart(() => {
        'worklet';
        runOnJS(onLongPress)(holdId);
      });
    // Long-press wins; tap fires only if the long-press fails (released early).
    return Gesture.Exclusive(longPress, tap);
  }, [holdId, onPaint, onLongPress]);

  return (
    <GestureDetector gesture={gesture}>
      <View
        collapsable={false}
        style={{
          position: 'absolute',
          left: `${leftPct}%`,
          top: `${topPct}%`,
          width: tapDiameter,
          height: tapDiameter,
          marginLeft: -tapDiameter / 2,
          marginTop: -tapDiameter / 2,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {showDot ? (
          <View
            pointerEvents="none"
            style={{
              width: dotDiameter,
              height: dotDiameter,
              borderRadius: dotDiameter / 2,
              backgroundColor: dotColor,
            }}
          />
        ) : null}
      </View>
    </GestureDetector>
  );
});
