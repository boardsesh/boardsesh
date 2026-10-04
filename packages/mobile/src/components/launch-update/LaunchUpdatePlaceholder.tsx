import { useEffect, useRef } from 'react';
import { Animated, Easing, StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { BoardseshLogo } from '../BoardseshLogo';
import { Text } from '../Text';
import { brandColors } from '../../theme/colors';
import { spacing } from '../../theme/tokens';
import { useLaunchUpdateGate, useLaunchUpdateProgress } from './use-launch-update-gate';

const PROGRESS_TRACK_WIDTH = 200;
const INDETERMINATE_SEGMENT_WIDTH = 72;
const INDETERMINATE_SWEEP_MS = 1_200;
// Matches the expo-splash-screen config in app.config.ts (backgroundColor
// #000000, imageWidth 200), so the hand-over from the native splash does not
// move the mark or flash a different black.
const SPLASH_BACKGROUND = '#000000';
const SPLASH_MARK_SIZE = 200;
const COPY_COLOR = 'rgba(255, 255, 255, 0.72)';
const TRACK_COLOR = 'rgba(255, 255, 255, 0.16)';

type LaunchUpdatePlaceholderProps = {
  visible: boolean;
  /** 0 to 1, or undefined before the download reports any progress. */
  progress: number | undefined;
};

function IndeterminateBar() {
  const sweep = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const loop = Animated.loop(
      Animated.timing(sweep, {
        toValue: 1,
        duration: INDETERMINATE_SWEEP_MS,
        easing: Easing.inOut(Easing.ease),
        useNativeDriver: true,
      }),
    );
    loop.start();
    return () => loop.stop();
  }, [sweep]);

  const translateX = sweep.interpolate({
    inputRange: [0, 1],
    outputRange: [-INDETERMINATE_SEGMENT_WIDTH, PROGRESS_TRACK_WIDTH],
  });

  return <Animated.View style={[styles.indeterminateSegment, { transform: [{ translateX }] }]} />;
}

/**
 * What the launch update gate shows once the wait outlasts the native splash:
 * the same black and the same mark, plus a progress bar and one line of copy.
 *
 * It covers the whole window and claims every touch, so the screens mounting
 * underneath (sign-in included) cannot be used until the gate resolves. That is
 * the point: nothing can be in flight when the reload lands.
 *
 * Rendered above `<DatabaseProvider>` and outside `ThemeProvider`, so it reads
 * static colours rather than the theme.
 */
export function LaunchUpdatePlaceholder({ visible, progress }: LaunchUpdatePlaceholderProps) {
  const { t } = useTranslation('common');
  if (!visible) return null;

  const message = t('mobile.launchUpdate.message');
  // A download that has reported nothing yet reads 0: an empty bar looks stuck,
  // so it stays indeterminate until there is something to show.
  const percent = progress === undefined || progress <= 0 ? undefined : Math.round(progress * 100);

  return (
    <View
      style={styles.container}
      accessible
      accessibilityViewIsModal
      accessibilityRole="progressbar"
      accessibilityLabel={message}
      accessibilityValue={percent === undefined ? undefined : { min: 0, max: 100, now: percent }}
      // Claim the touch so nothing underneath can respond to it.
      onStartShouldSetResponder={() => true}
      testID="launch-update-placeholder"
    >
      {/* The mark stays dead centre, where the splash drew it. The bar and the
          copy hang below it instead of sharing the centring. */}
      <View style={styles.mark}>
        <BoardseshLogo size={SPLASH_MARK_SIZE} />
        <View style={styles.details}>
          <View style={styles.track}>
            {percent === undefined ? <IndeterminateBar /> : <View style={[styles.fill, { width: `${percent}%` }]} />}
          </View>
          <Text variant="footnote" color={COPY_COLOR} style={styles.message}>
            {message}
          </Text>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    zIndex: 1000,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: SPLASH_BACKGROUND,
  },
  mark: {
    width: SPLASH_MARK_SIZE,
    height: SPLASH_MARK_SIZE,
  },
  details: {
    position: 'absolute',
    top: '100%',
    right: 0,
    left: 0,
    alignItems: 'center',
  },
  track: {
    width: PROGRESS_TRACK_WIDTH,
    height: 4,
    borderRadius: 2,
    overflow: 'hidden',
    backgroundColor: TRACK_COLOR,
  },
  fill: {
    height: '100%',
    borderRadius: 2,
    backgroundColor: brandColors.primary,
  },
  indeterminateSegment: {
    width: INDETERMINATE_SEGMENT_WIDTH,
    height: '100%',
    borderRadius: 2,
    backgroundColor: brandColors.primary,
  },
  message: {
    marginTop: spacing[4],
    textAlign: 'center',
  },
});

/**
 * The placeholder wired to the gate. A leaf on purpose: it is the only thing
 * that re-renders on download progress, so the root layout does not.
 */
export function LaunchUpdateGatePlaceholder() {
  const { showPlaceholder } = useLaunchUpdateGate();
  const progress = useLaunchUpdateProgress();
  return <LaunchUpdatePlaceholder visible={showPlaceholder} progress={progress} />;
}
