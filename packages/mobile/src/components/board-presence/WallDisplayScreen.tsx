import { memo, useCallback, useEffect, useMemo, type ReactNode } from 'react';
import { Platform, StyleSheet, View, type NativeSyntheticEvent } from 'react-native';
import Animated, { useAnimatedStyle, useReducedMotion, useSharedValue, withTiming } from 'react-native-reanimated';
import { useIsFocused } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { WallScreen } from './WallScreen';
import { Button } from '../Button';
import { useKeepAwakeWhile } from '../../hooks/use-keep-awake-while';
import { useAutoHidingChrome } from '../../hooks/use-auto-hiding-chrome';
import { useAssistiveTechnologyEnabled } from '../../hooks/use-assistive-technology-enabled';
import { useScopedRouter } from '../../lib/routing/scoped-navigation';
import { spacing } from '../../theme/tokens';
import { NativeSprayEditorKeyScope, type NativeShortcutCommand } from '../../../modules/spray-editor-input/src/index';

/** How long Exit and Settings stay up after the last touch. */
export const WALL_DISPLAY_CONTROLS_VISIBLE_MS = 4000;
const CONTROLS_FADE_MS = 250;
const EXIT_SHORTCUT_ID = 'exit';

/**
 * Esc and ⌘W leave the display from a hardware keyboard. They ride the native
 * key scope the hold editor ships (`modules/spray-editor-input`), which only
 * turns keys into ids: no native change. On a binary without that module the
 * scope is a plain `View` and the keys simply do nothing; Exit still works.
 */
function WallDisplayKeyScope({
  active,
  exitTitle,
  onExit,
  children,
}: {
  /** False while a page is pushed over the kiosk: Esc there is that page's. */
  active: boolean;
  exitTitle: string;
  onExit: () => void;
  children: ReactNode;
}) {
  const commands = useMemo<NativeShortcutCommand[]>(
    () =>
      active
        ? [
            // The first one is the one the iPad's ⌘-hold overlay lists.
            { id: EXIT_SHORTCUT_ID, input: 'w', modifiers: ['command'], title: exitTitle },
            { id: EXIT_SHORTCUT_ID, input: 'escape', modifiers: [], title: '' },
          ]
        : [],
    [active, exitTitle],
  );
  const handleShortcut = useCallback(
    (event: NativeSyntheticEvent<{ id: string }>) => {
      if (event.nativeEvent.id === EXIT_SHORTCUT_ID) onExit();
    },
    [onExit],
  );

  if (!NativeSprayEditorKeyScope) return <View style={styles.root}>{children}</View>;
  // Android's native scope is a LinearLayout that re-lays its direct children in
  // a row; one non-collapsable child that fills it keeps Fabric in charge (#6498,
  // the same wrapper SprayEditorKeyScope uses).
  return (
    <NativeSprayEditorKeyScope
      pointerEvents="box-none"
      style={styles.root}
      commands={commands}
      onShortcut={handleShortcut}
    >
      {Platform.OS === 'android' ? (
        <View collapsable={false} pointerEvents="box-none" style={StyleSheet.absoluteFill}>
          {children}
        </View>
      ) : (
        children
      )}
    </NativeSprayEditorKeyScope>
  );
}

/**
 * The Wall display: the wall kiosk with nothing else on screen, for an iPad
 * mounted at the board and read from 3–5 m. The route covers the sidebar, the
 * tab bar and the bottom accessory, and the screen stays awake while the kiosk
 * is the focused screen (not while a page is pushed over it).
 *
 * Exit and Settings sit together in the top leading corner, clear of the
 * kiosk's state strip on the trailing side, and fade out a few seconds after the
 * last touch; any touch brings them back (HIG, Going full screen). Faded, they
 * stay in the accessibility tree, and a press on them only brings them back.
 * With an assistive technology the app can detect, they never fade. Esc and ⌘W
 * exit from a hardware keyboard. The kiosk's own history controls stay put.
 */
function WallDisplayScreenComponent() {
  const { t } = useTranslation('session');
  const { t: tCommon } = useTranslation('common');
  const router = useScopedRouter();
  const insets = useSafeAreaInsets();
  const reduceMotion = useReducedMotion();
  const assistiveTechnologyEnabled = useAssistiveTechnologyEnabled();
  // Only while the kiosk itself is on screen: a notification's page or Settings
  // pushed over it lets the screen dim again.
  const isFocused = useIsFocused();
  useKeepAwakeWhile(isFocused, 'wall');

  const {
    visible: controlsVisible,
    handleTouchStart,
    guardPress,
  } = useAutoHidingChrome({
    visibleMs: WALL_DISPLAY_CONTROLS_VISIBLE_MS,
    pinned: assistiveTechnologyEnabled,
  });

  const controlsOpacity = useSharedValue(1);
  useEffect(() => {
    controlsOpacity.value = withTiming(controlsVisible ? 1 : 0, { duration: reduceMotion ? 0 : CONTROLS_FADE_MS });
  }, [controlsOpacity, controlsVisible, reduceMotion]);
  const controlsAnimatedStyle = useAnimatedStyle(() => ({ opacity: controlsOpacity.value }));

  const exit = useCallback(() => {
    // Opened by the old wall link on a cold start, the display can be the only
    // screen in the stack; leave to the app's root then.
    if (router.canGoBack()) router.back();
    else router.replace('/');
  }, [router]);

  // Scoped to this route's own Settings stack (scoped-navigation.ts), so Back
  // returns to the display.
  const openSettings = useCallback(() => router.push('/settings'), [router]);
  const handleExitPress = useMemo(() => guardPress(exit), [guardPress, exit]);
  const handleSettingsPress = useMemo(() => guardPress(openSettings), [guardPress, openSettings]);
  const exitTitle = t('mobile.boardPresence.wallDisplay.exitA11y');

  return (
    <WallDisplayKeyScope active={isFocused} exitTitle={exitTitle} onExit={exit}>
      <View style={styles.root} onTouchStart={handleTouchStart}>
        <WallScreen />
        <Animated.View
          // The id says whether the controls are faded, so a capture can wait for it.
          testID={controlsVisible ? 'wall-display-controls' : 'wall-display-controls-faded'}
          pointerEvents="box-none"
          style={[
            styles.controls,
            { top: insets.top + spacing[3], start: insets.left + spacing[4] },
            controlsAnimatedStyle,
          ]}
        >
          <Button
            title={t('mobile.boardPresence.wallDisplay.exit')}
            accessibilityLabel={exitTitle}
            icon="close"
            variant="tonal"
            over="content"
            onPress={handleExitPress}
          />
          <Button
            title={tCommon('mobile.settings.title')}
            icon="settings"
            variant="tonal"
            over="content"
            onPress={handleSettingsPress}
          />
        </Animated.View>
      </View>
    </WallDisplayKeyScope>
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
