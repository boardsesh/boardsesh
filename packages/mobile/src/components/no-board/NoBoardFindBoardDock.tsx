// "Find my board", docked above the tab bar for the whole no-board preview.
//
// It is the one action on the screen that binds a board, so it does not scroll
// away with the header. The fade under it keeps the rows that pass behind from
// reading through the button.

import { memo, useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Button } from '../Button';
import { useBottomChromeMetrics } from '../../hooks/use-bottom-chrome-metrics';
import { shadows, spacing } from '../../theme/tokens';
import { NO_BOARD_DOCK_BUTTON_HEIGHT, NO_BOARD_HERO_GUTTER } from '../../lib/boards/no-board-hero-layout';

/** The gap between the dock and the chrome under it. */
export const NO_BOARD_DOCK_GAP = spacing[2];

// How far above the button's bottom edge the fade starts.
const FADE_REACH = 96;

const FADE_START = { x: 0.5, y: 0 } as const;
const FADE_END = { x: 0.5, y: 1 } as const;

type NoBoardFindBoardDockProps = {
  title: string;
  onPress: () => void;
  /** The screen background at zero alpha and at the fade's full strength. Concrete colours only. */
  fadeFrom: string;
  fadeTo: string;
};

function NoBoardFindBoardDockComponent({ title, onPress, fadeFrom, fadeTo }: NoBoardFindBoardDockProps) {
  const { floatingControlBottom } = useBottomChromeMetrics();
  const buttonBottom = floatingControlBottom + NO_BOARD_DOCK_GAP;
  // The fade runs on to the bottom of the screen: stopping it at the button
  // would leave a hard edge between the dock and the tab bar.
  const fadeHeight = buttonBottom + FADE_REACH;
  const fadeColors = useMemo(() => [fadeFrom, fadeTo, fadeTo] as const, [fadeFrom, fadeTo]);
  // Full strength by the middle of the button.
  const fadeLocations = useMemo(
    () => [0, (FADE_REACH - NO_BOARD_DOCK_BUTTON_HEIGHT / 2) / fadeHeight, 1] as const,
    [fadeHeight],
  );

  return (
    <>
      <LinearGradient
        pointerEvents="none"
        colors={fadeColors}
        locations={fadeLocations}
        start={FADE_START}
        end={FADE_END}
        style={[styles.fade, { height: fadeHeight }]}
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
