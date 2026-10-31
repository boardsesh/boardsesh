import { PressableSurface } from '../PressableSurface';
import type { ReactNode } from 'react';
import { Platform, StyleSheet, type PressableProps, type StyleProp, type ViewStyle } from 'react-native';
import { Link } from 'expo-router';
import { useReduceMotion } from '../../hooks/use-reduce-motion';
import { useScreenReaderEnabled } from '../../hooks/use-screen-reader-enabled';
import { opacity } from '../../theme/tokens';

type AccessoryPlayLinkProps = {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  accessibilityLabel: string;
  testID?: string;
  /** Spoken after the label, e.g. the board connection the platter shows only as a mark. */
  accessibilityValue?: string;
  onOpen: () => void;
  onPrepare: () => boolean;
  /** Only native tab accessory hosts retain the source beneath /play. */
  zoomSourceRetained?: boolean;
};

// Keep the pressed-style function inside the component: Router's Slot merges
// static styles, so giving it a Pressable style function would erase feedback.
function PlayPressable({ style, ...props }: Omit<PressableProps, 'style'> & { style?: StyleProp<ViewStyle> }) {
  return (
    <PressableSurface
      {...props}
      role="button"
      accessibilityRole="button"
      android_ripple={{ borderless: false }}
      style={({ pressed }) => [style, pressed && { opacity: opacity.subtle }]}
    />
  );
}

/** The source stays in the tab accessory so UIKit can zoom back to it. */
export function AccessoryPlayLink({
  children,
  style,
  accessibilityLabel,
  testID,
  accessibilityValue,
  onOpen,
  onPrepare,
  zoomSourceRetained: hostRetainsZoomSource = false,
}: AccessoryPlayLinkProps) {
  // UIKit's zoom leaves the presented player, and this source, out of the
  // accessibility tree (#7082), so VoiceOver gets the climb row's open instead.
  const screenReaderEnabled = useScreenReaderEnabled();
  const zoomSourceRetained = hostRetainsZoomSource && !screenReaderEnabled;
  const reduceMotion = useReduceMotion();
  // iPad too: like Music's MiniPlayer, the accessory zooms into the full-screen player.
  const supportsZoom = zoomSourceRetained && Platform.OS === 'ios' && Number(Platform.Version) >= 18 && !reduceMotion;
  const content = (
    <PlayPressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityValue={accessibilityValue ? { text: accessibilityValue } : undefined}
      onPress={supportsZoom ? undefined : onOpen}
      style={StyleSheet.flatten(style)}
    >
      {children}
    </PlayPressable>
  );
  if (!supportsZoom) return content;
  return (
    <Link
      href="/play"
      asChild
      onPress={(event) => {
        if (!onPrepare()) event.preventDefault();
      }}
    >
      <Link.AppleZoom>{content}</Link.AppleZoom>
    </Link>
  );
}
