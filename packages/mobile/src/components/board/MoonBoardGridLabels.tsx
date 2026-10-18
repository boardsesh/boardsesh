import React from 'react';
import { StyleSheet } from 'react-native';
import { Image } from 'expo-image';
import { useSetting } from '../../settings';
import { bundledBoardArtSource, type BackgroundColorScheme } from '../../lib/bundled-board-art';
import { moonBoardGridLabelsImageKey } from '../../lib/board-details';

type MoonBoardGridLabelsProps = {
  layoutId: number;
  /**
   * The scheme the board's own art resolved in (`useNativeClimbRender`), so the
   * labels and the stack under them always switch to their dark copies together.
   */
  colorScheme: BackgroundColorScheme;
};

/**
 * The MoonBoard's A-K column letters and row numbers, drawn from the board's own
 * label art so they line up with the holds on every layout (issue #6234).
 *
 * Rendered above the holds overlay (`LayeredClimbImage`'s `aboveOverlay`), not in
 * the background stack: in dark mode the overlay washes the unlit wall, and the
 * labels went down with it. Up here they keep the contrast the dark label art was
 * drawn for, and light mode looks as it always has.
 *
 * Decorative: hidden from screen readers and from touches, so a tap on a hold in
 * column A or row 18 still lands. The board's own accessibility label is the
 * text alternative.
 */
export const MoonBoardGridLabels = React.memo(function MoonBoardGridLabels({
  layoutId,
  colorScheme,
}: MoonBoardGridLabelsProps) {
  const [showGridLabels] = useSetting('moonboardGridLabels');
  if (!showGridLabels) return null;
  const labelArtSource = bundledBoardArtSource(moonBoardGridLabelsImageKey(layoutId), colorScheme);
  if (labelArtSource === null) return null;
  return (
    <Image
      testID="moonboard-grid-labels"
      source={labelArtSource}
      style={styles.fill}
      // Same fit and cache rules as the background layers it used to sit among,
      // so it lands on exactly the same pixels. See `LayeredClimbImage`.
      contentFit="contain"
      cachePolicy="memory"
      allowDownscaling={false}
      transition={0}
      pointerEvents="none"
      accessible={false}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    />
  );
});

const styles = StyleSheet.create({
  fill: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
  },
});
