import { memo, useCallback, useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, { useAnimatedStyle, useReducedMotion, useSharedValue, withTiming } from 'react-native-reanimated';
import { useTranslation } from 'react-i18next';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { WallScreen } from './WallScreen';
import { Button } from '../Button';
import { useKeepAwakeWhile } from '../../hooks/use-keep-awake-while';
import { useAutoHidingChrome } from '../../hooks/use-auto-hiding-chrome';
import { useScreenReaderEnabled } from '../../hooks/use-screen-reader-enabled';
import { useScopedRouter } from '../../lib/routing/scoped-navigation';
import { spacing } from '../../theme/tokens';

/** How long Exit and Settings stay up after the last touch. */
export const WALL_DISPLAY_CONTROLS_VISIBLE_MS = 4000;
const CONTROLS_FADE_MS = 250;

/**
 * The Wall display: the wall kiosk with nothing else on screen, for an iPad
 * mounted at the board and read from 3–5 m. The route covers the sidebar, the
 * tab bar and the bottom accessory, and the screen stays awake while it is up.
 *
 * Exit and Settings sit together in the top leading corner, clear of the
 * kiosk's state strip on the trailing side, and fade out a few seconds after the
 * last touch; any touch brings them back (HIG, Going full screen). The kiosk's
 * own history controls stay where they are. With VoiceOver or TalkBack on, the
 * controls never fade, because there is no "tap anywhere" to bring them back.
 */
function WallDisplayScreenComponent() {
  const { t } = useTranslation('session');
  const { t: tCommon } = useTranslation('common');
  const router = useScopedRouter();
  const insets = useSafeAreaInsets();
  const reduceMotion = useReducedMotion();
  const screenReaderEnabled = useScreenReaderEnabled();
  useKeepAwakeWhile(true, 'wall');

  const { visible: controlsVisible, reveal: revealControls } = useAutoHidingChrome({
    visibleMs: WALL_DISPLAY_CONTROLS_VISIBLE_MS,
    pinned: screenReaderEnabled,
  });

  const controlsOpacity = useSharedValue(1);
  useEffect(() => {
    controlsOpacity.value = withTiming(controlsVisible ? 1 : 0, { duration: reduceMotion ? 0 : CONTROLS_FADE_MS });
  }, [controlsOpacity, controlsVisible, reduceMotion]);
  const controlsAnimatedStyle = useAnimatedStyle(() => ({ opacity: controlsOpacity.value }));

  const handleExit = useCallback(() => {
    // Opened by the old wall link on a cold start, the display can be the only
    // screen in the stack; leave to the app's root then.
    if (router.canGoBack()) router.back();
    else router.replace('/');
  }, [router]);

  // Scoped to this route's own Settings stack (scoped-navigation.ts), so Back
  // returns to the display.
  const handleOpenSettings = useCallback(() => router.push('/settings'), [router]);

  return (
    <View style={styles.root} onTouchStart={revealControls}>
      <WallScreen />
      <Animated.View
        testID="wall-display-controls"
        pointerEvents={controlsVisible ? 'box-none' : 'none'}
        accessibilityElementsHidden={!controlsVisible}
        importantForAccessibility={controlsVisible ? 'auto' : 'no-hide-descendants'}
        style={[
          styles.controls,
          { top: insets.top + spacing[3], start: insets.left + spacing[4] },
          controlsAnimatedStyle,
        ]}
      >
        <Button
          title={t('mobile.boardPresence.wallDisplay.exit')}
          accessibilityLabel={t('mobile.boardPresence.wallDisplay.exitA11y')}
          icon="close"
          variant="tonal"
          over="content"
          onPress={handleExit}
        />
        <Button
          title={tCommon('mobile.settings.title')}
          icon="settings"
          variant="tonal"
          over="content"
          onPress={handleOpenSettings}
        />
      </Animated.View>
    </View>
  );
}

export const WallDisplayScreen = memo(WallDisplayScreenComponent);

const styles = StyleSheet.create({
  root: { flex: 1 },
  controls: {
    position: 'absolute',
    flexDirection: 'row',
    gap: spacing[3],
  },
});
