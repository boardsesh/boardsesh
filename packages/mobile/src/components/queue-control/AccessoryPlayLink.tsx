import { PressableSurface } from '../PressableSurface';
import type { ReactNode } from 'react';
import { Platform, StyleSheet, type PressableProps, type StyleProp, type ViewStyle } from 'react-native';
import { Link } from 'expo-router';
import { useReduceMotion } from '../../hooks/use-reduce-motion';
import { opacity } from '../../theme/tokens';

type AccessoryPlayLinkProps = {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  accessibilityLabel: string;
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
  onOpen,
  onPrepare,
  zoomSourceRetained = false,
}: AccessoryPlayLinkProps) {
  const reduceMotion = useReduceMotion();
  const supportsZoom =
    zoomSourceRetained && Platform.OS === 'ios' && !Platform.isPad && Number(Platform.Version) >= 18 && !reduceMotion;
  const content = (
    <PlayPressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
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
