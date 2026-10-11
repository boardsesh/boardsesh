// "Find my board", docked above the tab bar for the whole no-board preview.
//
// It is the one action on the screen that binds a board, so it does not scroll
// away with the header. From the button's top edge down the screen is the plain
// background, so no row shows beside or under it; above that a short fade lets
// the rows slide out of sight.

import { memo, useEffect, useMemo, useState } from 'react';
import { Keyboard, Platform, StyleSheet, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Button } from '../Button';
import { useBottomChromeMetrics } from '../../hooks/use-bottom-chrome-metrics';
import { useConnectivityBannerHeight } from '../../lib/connectivity-banner-inset-store';
import { shadows, spacing } from '../../theme/tokens';
import { NO_BOARD_DOCK_BUTTON_HEIGHT, NO_BOARD_HERO_GUTTER } from '../../lib/boards/no-board-hero-layout';

/** The gap between the dock and the chrome under it. */
export const NO_BOARD_DOCK_GAP = spacing[2];

// How far above the button's top edge the rows start to fade out.
const FADE_REACH = 28;

const FADE_START = { x: 0.5, y: 0 } as const;
const FADE_END = { x: 0.5, y: 1 } as const;

// iOS says so before the keyboard moves, so the dock is gone by the time it is up.
const KEYBOARD_SHOW_EVENT = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
const KEYBOARD_HIDE_EVENT = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';

function useKeyboardShown(): boolean {
  const [keyboardShown, setKeyboardShown] = useState(() => Keyboard.isVisible());
  useEffect(() => {
    const showSubscription = Keyboard.addListener(KEYBOARD_SHOW_EVENT, () => setKeyboardShown(true));
    const hideSubscription = Keyboard.addListener(KEYBOARD_HIDE_EVENT, () => setKeyboardShown(false));
    return () => {
      showSubscription.remove();
      hideSubscription.remove();
    };
  }, []);
  return keyboardShown;
}

type NoBoardFindBoardDockProps = {
  title: string;
  onPress: () => void;
  /** The screen background at zero alpha and opaque. Concrete colours only. */
  fadeFrom: string;
  fadeTo: string;
};

function NoBoardFindBoardDockComponent({ title, onPress, fadeFrom, fadeTo }: NoBoardFindBoardDockProps) {
  const { floatingControlBottom } = useBottomChromeMetrics();
  const keyboardShown = useKeyboardShown();
  const connectivityBannerHeight = useConnectivityBannerHeight();
  const buttonBottom = floatingControlBottom + NO_BOARD_DOCK_GAP;
  // Opaque from the button's top edge to the bottom of the screen.
  const scrimHeight = buttonBottom + NO_BOARD_DOCK_BUTTON_HEIGHT + FADE_REACH;
  const fadeColors = useMemo(() => [fadeFrom, fadeTo, fadeTo] as const, [fadeFrom, fadeTo]);
  const fadeLocations = useMemo(() => [0, FADE_REACH / scrimHeight, 1] as const, [scrimHeight]);

  // Two things take the dock's place. The keyboard sits where it would be, and
  // the button would show through its translucent keys. The connectivity banner
  // floats above the bottom chrome and would push the button up over the board;
  // while it is up there is no backend to find a board on anyway.
  if (keyboardShown || connectivityBannerHeight > 0) return null;

  return (
    <>
      <LinearGradient
        pointerEvents="none"
        colors={fadeColors}
        locations={fadeLocations}
        start={FADE_START}
        end={FADE_END}
        style={[styles.fade, { height: scrimHeight }]}
      />
      <View style={[styles.dock, { bottom: buttonBottom }]}>
        <Button
          testID="no-board-preview-find-board"
          title={title}
          onPress={onPress}
          variant="filled"
          size="large"
          minHeight={NO_BOARD_DOCK_BUTTON_HEIGHT}
          style={styles.button}
        />
      </View>
    </>
  );
}

export const NoBoardFindBoardDock = memo(NoBoardFindBoardDockComponent);

const styles = StyleSheet.create({
  fade: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
  },
  dock: {
    position: 'absolute',
    left: NO_BOARD_HERO_GUTTER,
    right: NO_BOARD_HERO_GUTTER,
    ...shadows.lg,
  },
  button: {
    alignSelf: 'stretch',
  },
});
