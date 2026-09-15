// Mark the wall's four corners on the photo (epic #5346, SW-09).
//
// Optional, and "Skip" is the default. With no anchors the canonical frame is the
// photo's own pixel box, which is right for a wall shot square on — and a wall
// shot square on is what the guidance copy asks for. What the anchors buy is the
// NEXT photo: a wall reset months later is photographed from a slightly different
// spot, and the two photos only agree about where a hold is if each carries a
// quad naming the same four points on the real wall.
//
// Four independent handles rather than one draggable quad, because the gesture
// that matters is "that corner is a bit left of where you put it". Each handle
// owns a shared value and a pan; nothing crosses to JS until the finger lifts, so
// dragging a corner is a worklet-only operation and the screen does not re-render
// per frame.
//
// Coordinates on screen are RENDER pixels (the photo drawn to fit the width).
// Coordinates leaving this component are PHOTO pixels, which is what
// `createSprayWallVersion` stores and what the homography is solved in.

import { useCallback, useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import { Image } from 'expo-image';
import { useTranslation } from 'react-i18next';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { runOnJS, useAnimatedStyle, useSharedValue, type SharedValue } from 'react-native-reanimated';
import type { Quad } from '@boardsesh/spray-wall-geometry';
import { useTheme } from '../../providers/theme-provider';
import { Text } from '../Text';
import { spacing, borderRadius } from '../../theme/tokens';
import { iosSystemColors } from '../../theme/ios-colors';

/** Touch target for one corner. Bigger than the ring it draws, so a thumb can find it. */
const HANDLE_SIZE = 44;
/** The visible ring inside that target. */
const RING_SIZE = 28;

/**
 * How far in from each edge an unmarked quad starts.
 *
 * Not the exact corners: a quad already sitting on the photo's edge looks
 * finished, and the whole point of this step is that the climber MOVES the four
 * points onto the wall. A tenth of the frame reads as "these are a guess".
 */
const DEFAULT_INSET = 0.1;

export type SprayCornerMarkerProps = {
  photo: { uri: string; width: number; height: number };
  /** Width the photo is drawn at. The height follows from its aspect ratio. */
  renderWidth: number;
  /** The quad to open with, in photo pixels, or null to start from the default inset. */
  value: Quad | null;
  /** Fired when a corner is released, with all four in photo pixels, TL/TR/BR/BL. */
  onChange: (quad: Quad) => void;
  /** True once the quad has been refused for crossing itself; paints the guides red. */
  invalid?: boolean;
};

const CORNER_ORDER = [0, 1, 2, 3] as const;

/** The default quad, in photo pixels, TL/TR/BR/BL. */
function defaultQuad(width: number, height: number): Quad {
  const insetX = width * DEFAULT_INSET;
  const insetY = height * DEFAULT_INSET;
  return [
    [insetX, insetY],
    [width - insetX, insetY],
    [width - insetX, height - insetY],
    [insetX, height - insetY],
  ];
}

export function SprayCornerMarker({ photo, renderWidth, value, onChange, invalid = false }: SprayCornerMarkerProps) {
  const { t } = useTranslation('boards');
  const { systemColors } = useTheme();

  const aspect = photo.height > 0 ? photo.width / photo.height : 1;
  const renderHeight = renderWidth / (aspect > 0 ? aspect : 1);
  /** Photo px per render px. One number: the photo is drawn to fit, never stretched. */
  const photoScale = photo.width > 0 ? photo.width / renderWidth : 1;

  const seed = useMemo(() => value ?? defaultQuad(photo.width, photo.height), [value, photo.width, photo.height]);

  // Four handles, four pairs of shared values. Written unrolled because hooks
  // cannot be called in a loop whose length could ever change — and this one
  // cannot, which is exactly why unrolling costs nothing.
  const x0 = useSharedValue(seed[0][0] / photoScale);
  const y0 = useSharedValue(seed[0][1] / photoScale);
  const x1 = useSharedValue(seed[1][0] / photoScale);
  const y1 = useSharedValue(seed[1][1] / photoScale);
  const x2 = useSharedValue(seed[2][0] / photoScale);
  const y2 = useSharedValue(seed[2][1] / photoScale);
  const x3 = useSharedValue(seed[3][0] / photoScale);
  const y3 = useSharedValue(seed[3][1] / photoScale);

  const xs = useMemo(() => [x0, x1, x2, x3], [x0, x1, x2, x3]);
  const ys = useMemo(() => [y0, y1, y2, y3], [y0, y1, y2, y3]);

  /**
   * Read all four handles and report them in photo pixels.
   *
   * Called from a gesture's `onEnd` through `runOnJS`, once per drag — never per
   * frame. Reading the other three shared values from JS is safe here for the
   * same reason: by the time this runs, no worklet is writing them.
   */
  const commit = useCallback(() => {
    const quad: Quad = [
      [x0.value * photoScale, y0.value * photoScale],
      [x1.value * photoScale, y1.value * photoScale],
      [x2.value * photoScale, y2.value * photoScale],
      [x3.value * photoScale, y3.value * photoScale],
    ];
    onChange(quad);
  }, [x0, y0, x1, y1, x2, y2, x3, y3, photoScale, onChange]);

  const guideColor = invalid ? iosSystemColors.systemRed : iosSystemColors.systemBlue;

  // Written out rather than looked up by index: the i18n linter only accepts
  // literal keys, and four corners is four lines.
  const cornerLabels = [
    t('sprayWizard.anchors.cornerTopLeft'),
    t('sprayWizard.anchors.cornerTopRight'),
    t('sprayWizard.anchors.cornerBottomRight'),
    t('sprayWizard.anchors.cornerBottomLeft'),
  ];

  return (
    <View style={styles.container}>
      <View style={[styles.frame, { width: renderWidth, height: renderHeight, borderRadius: borderRadius.lg }]}>
        <Image
          source={{ uri: photo.uri }}
          style={StyleSheet.absoluteFill}
          contentFit="cover"
          accessibilityIgnoresInvertColors
        />
        {CORNER_ORDER.map((corner) => (
          <CornerHandle
            key={corner}
            x={xs[corner]}
            y={ys[corner]}
            maxX={renderWidth}
            maxY={renderHeight}
            color={guideColor}
            label={cornerLabels[corner]}
            onCommit={commit}
          />
        ))}
      </View>
      <Text
        variant="footnote"
        color={invalid ? iosSystemColors.systemRed : systemColors.secondaryLabel}
        style={styles.hint}
      >
        {invalid ? t('sprayWizard.anchors.crossed') : t('sprayWizard.anchors.hint')}
      </Text>
    </View>
  );
}

function CornerHandle({
  x,
  y,
  maxX,
  maxY,
  color,
  label,
  onCommit,
}: {
  x: SharedValue<number>;
  y: SharedValue<number>;
  maxX: number;
  maxY: number;
  color: string;
  label: string;
  onCommit: () => void;
}) {
  const startX = useSharedValue(0);
  const startY = useSharedValue(0);

  const pan = useMemo(
    () =>
      Gesture.Pan()
        .onBegin(() => {
          startX.value = x.value;
          startY.value = y.value;
        })
        .onUpdate((event) => {
          // Clamped to the photo: an anchor outside the frame describes a corner
          // the photograph never saw, and the homography solved from it maps the
          // wall to somewhere nobody can check.
          x.value = Math.min(maxX, Math.max(0, startX.value + event.translationX));
          y.value = Math.min(maxY, Math.max(0, startY.value + event.translationY));
        })
        .onEnd(() => {
          runOnJS(onCommit)();
        }),
    [x, y, startX, startY, maxX, maxY, onCommit],
  );

  const style = useAnimatedStyle(() => ({
    transform: [{ translateX: x.value - HANDLE_SIZE / 2 }, { translateY: y.value - HANDLE_SIZE / 2 }],
  }));

  return (
    <GestureDetector gesture={pan}>
      <Animated.View
        style={[styles.handle, style]}
        accessible
        accessibilityRole="adjustable"
        accessibilityLabel={label}
      >
        <View style={[styles.ring, { borderColor: color }]} />
      </Animated.View>
    </GestureDetector>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    gap: spacing[3],
  },
  frame: {
    overflow: 'hidden',
    backgroundColor: '#000000',
  },
  handle: {
    position: 'absolute',
    width: HANDLE_SIZE,
    height: HANDLE_SIZE,
    alignItems: 'center',
    justifyContent: 'center',
  },
  ring: {
    width: RING_SIZE,
    height: RING_SIZE,
    borderRadius: RING_SIZE / 2,
    borderWidth: 3,
    backgroundColor: 'rgba(255, 255, 255, 0.25)',
  },
  hint: {
    textAlign: 'center',
    paddingHorizontal: spacing[4],
  },
});
