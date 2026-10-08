import { useCallback, useEffect, useState } from 'react';
import { StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import { Image, type ImageLoadEventData } from 'expo-image';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';
import { Text } from '../Text';
import { Button } from '../Button';
import { ActivityIndicator } from '../ActivityIndicator';
import { GlassSurface } from '../GlassSurface';
import { useTheme } from '../../providers/theme-provider';
import { borderRadius, overlays, spacing } from '../../theme/tokens';
import { SprayScanBand, SCAN_BAND_HEIGHT } from '../outline-editor/SprayScanBand';
import { fitSprayPhoto, SPRAY_BAR_GUTTER } from '../outline-editor/spray-photo-frame';
import { sprayPhotoReservesBottom, useSprayEditorLayout } from '../outline-editor/use-spray-editor-layout';

/** One pass of the band from the top of the photo to the bottom. */
const SCAN_PASS_MS = 1800;

/** Used only until a photo that arrived without a size has loaded and reported one. */
const FALLBACK_ASPECT = { width: 4, height: 3 };

export type SprayScanAction = {
  label: string;
  onPress: () => void;
};

type SprayScanPhotoProps = {
  /** The climber's own photo, as picked: a local file and its pixel size. */
  photo: { uri: string; width: number; height: number };
  /** The one status line: queued, running, or what went wrong. */
  message: string;
  /** A second, quieter line (a slow queue), or null. */
  detail?: string | null;
  /** That leaving now loses nothing: the scan keeps going and the flow resumes. */
  resumeHint?: string;
  /** The scan stopped. The band goes, and `retry` becomes the filled action. */
  failed: boolean;
  retry?: SprayScanAction & { disabled?: boolean };
  /** "Mark holds myself": skips the scan and opens the editor empty. */
  manual?: SprayScanAction;
  /**
   * False when the wait is not a scan: the hold editor fetching its wall. The
   * band stays off and the card carries a spinner, so a finished scan is never
   * shown as still running. Defaults to true.
   */
  band?: boolean;
};

/**
 * The detect step for a wall whose photo is on this phone: the photo
 * full-bleed, dimmed, with a violet band sweeping down it while the server
 * looks for holds, and a glass card at the bottom saying where the job is.
 *
 * The photo sits exactly where the hold editor will put it (`fitSprayPhoto`),
 * so when detection lands the rings appear on the same pixels the band was
 * sweeping. The band is one view moved by a UI-thread `withRepeat`; nothing
 * re-renders per frame. With Reduce Motion there is no band, only a small
 * spinner in the card.
 */
export function SprayScanPhoto({
  photo,
  message,
  detail,
  resumeHint,
  failed,
  retry,
  manual,
  band = true,
}: SprayScanPhotoProps) {
  const { systemColors } = useTheme();
  const insets = useSafeAreaInsets();
  const reduceMotion = useReducedMotion();
  const { layout } = useSprayEditorLayout();
  const [area, setArea] = useState({ width: 0, height: 0 });
  const [loadedSize, setLoadedSize] = useState<{ width: number; height: number } | null>(null);

  const handleLayout = useCallback((event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    setArea((previous) => (previous.width === width && previous.height === height ? previous : { width, height }));
  }, []);

  const photoHasSize = photo.width > 0 && photo.height > 0;
  const handleLoad = useCallback(
    (event: ImageLoadEventData) => {
      if (photoHasSize) return;
      setLoadedSize({ width: event.source.width, height: event.source.height });
    },
    [photoHasSize],
  );

  const size = photoHasSize ? photo : (loadedSize ?? FALLBACK_ASPECT);
  const frame = fitSprayPhoto({
    areaWidth: area.width,
    areaHeight: area.height,
    bottomInset: insets.bottom,
    photoWidth: size.width,
    photoHeight: size.height,
    // The hold editor fits with the same answer, or the rings would not land
    // where the band swept.
    reserveBottom: sprayPhotoReservesBottom(layout),
  });

  const scanning = band && !failed && !reduceMotion && frame.height > 0;
  const progressSV = useSharedValue(0);
  useEffect(() => {
    if (!scanning) {
      cancelAnimation(progressSV);
      return;
    }
    progressSV.value = 0;
    progressSV.value = withRepeat(withTiming(1, { duration: SCAN_PASS_MS, easing: Easing.linear }), -1, false);
    return () => cancelAnimation(progressSV);
  }, [scanning, progressSV]);

  const travel = frame.height + SCAN_BAND_HEIGHT;
  const bandStyle = useAnimatedStyle(
    () => ({ transform: [{ translateY: progressSV.value * travel - SCAN_BAND_HEIGHT }] }),
    [travel],
  );

  return (
    <View style={[styles.root, { backgroundColor: systemColors.background }]} onLayout={handleLayout}>
      {frame.width > 0 ? (
        <View style={[styles.slot, { height: frame.slotHeight }]}>
          <View style={[styles.photo, { width: frame.width, height: frame.height }]}>
            <Image
              source={{ uri: photo.uri }}
              style={StyleSheet.absoluteFill}
              contentFit="contain"
              onLoad={handleLoad}
              accessibilityIgnoresInvertColors
            />
            <View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: overlays.photoDimScan }]} />
            {scanning ? <SprayScanBand style={bandStyle} /> : null}
          </View>
        </View>
      ) : null}

      <View style={[styles.card, { bottom: insets.bottom + SPRAY_BAR_GUTTER }]}>
        <GlassSurface
          glassEffectStyle="regular"
          fallbackColor={systemColors.secondaryBackground}
          borderRadius={borderRadius.xl}
          style={StyleSheet.absoluteFill}
          pointerEvents="none"
        />
        <View style={styles.statusRow}>
          {(reduceMotion || !band) && !failed ? <ActivityIndicator /> : null}
          <Text
            variant="headline"
            color={systemColors.label}
            style={styles.statusText}
            accessibilityRole="header"
            accessibilityLiveRegion="polite"
          >
            {message}
          </Text>
        </View>
        {detail ? (
          <Text variant="subheadline" color={systemColors.secondaryLabel} accessibilityLiveRegion="polite">
            {detail}
          </Text>
        ) : null}
        {resumeHint ? (
          <Text variant="footnote" color={systemColors.secondaryLabel}>
            {resumeHint}
          </Text>
        ) : null}
        {failed && retry ? (
          <Button
            title={retry.label}
            variant="filled"
            size="large"
            over="surface"
            onPress={retry.onPress}
            disabled={retry.disabled}
          />
        ) : null}
        {manual ? <Button title={manual.label} variant="text" over="surface" onPress={manual.onPress} /> : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
  slot: {
    alignSelf: 'stretch',
    alignItems: 'center',
    justifyContent: 'center',
  },
  photo: {
    overflow: 'hidden',
  },
  card: {
    position: 'absolute',
    left: spacing[4],
    right: spacing[4],
    borderRadius: borderRadius.xl,
    overflow: 'hidden',
    padding: spacing[4],
    gap: spacing[2],
  },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[2],
  },
  statusText: {
    flex: 1,
  },
});
