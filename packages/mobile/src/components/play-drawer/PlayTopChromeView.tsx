import type { ReactNode } from 'react';
import { View, StyleSheet, type LayoutChangeEvent } from 'react-native';
import { ChromeIconButton } from '../ChromeIconButton';
import { spacing, sheetStyles } from '../../theme/tokens';
const TOP_TRAILING_CENTRE_CLEARANCE = 26;
export function PlayTopChromeView({
  isPane = false,
  onDismiss,
  closeLabel,
  chromeButtonSize,
  onTrailingLayout,
  caption,
  trailing,
}: {
  isPane?: boolean;
  onDismiss: () => void;
  closeLabel: string;
  chromeButtonSize: number;
  onTrailingLayout?: (event: LayoutChangeEvent) => void;
  caption?: ReactNode;
  trailing?: ReactNode;
}) {
  return (
    <View style={styles.topRow}>
      {/* The persistent pane has no dismiss, so it shows no grabber or
                          close chevron; the route keeps both. */}
      {!isPane ? (
        <>
          <View style={[sheetStyles.indicator, styles.grabber]} />
          {/* A chevron, not an xmark: the player minimises, it isn't closed. */}
          <ChromeIconButton
            testID="play-drawer-close"
            icon="chevron.down"
            onPress={onDismiss}
            accessibilityLabel={closeLabel}
            style={styles.closeButton}
          />
        </>
      ) : null}
      {/* The workout stage or the list the player walks, under the grabber. Takes no
                          touches of its own, but keeps them (no pointerEvents="none"),
                          which on Android would hide it from TalkBack's explore by touch. */}
      {caption}
      {/* Mirrored across the grabber from the close chevron: the rest
                          timer (#5378), then ⋯. The timer has its own host — and so its
                          own sheet — because a root-level sheet would present UNDER this
                          transparent modal. The cluster runs from just right of the
                          grabber to the edge, so the grabber stays centred and a long
                          timer shrinks rather than sliding under it. It sits outside
                          the commit bar and the switch-board scrim, so ⋯ stays in reach
                          while browsing and on another board's climb. */}
      <View style={[styles.topTrailing, { height: chromeButtonSize }]} pointerEvents="box-none">
        <View style={styles.topTrailingContent} onLayout={onTrailingLayout}>
          {trailing}
        </View>
      </View>
    </View>
  );
}
const styles = StyleSheet.create({
  grabber: {
    position: 'absolute',
    top: 5,
  },
  topTrailingContent: {
    flexDirection: 'row',
    alignItems: 'center',
    flexShrink: 1,
    minWidth: 0,
  },
  topRow: {
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  topTrailing: {
    position: 'absolute',
    top: 0,
    left: '50%',
    marginLeft: TOP_TRAILING_CENTRE_CLEARANCE,
    right: spacing[2],
    zIndex: 2,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
  },
  closeButton: {
    position: 'absolute',
    top: 0,
    left: spacing[2],
    zIndex: 2,
  },
});
