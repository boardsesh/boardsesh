// Screenshot mode ONLY: a showcase-video anchor for a native bar item.
//
// The recorder points its callouts at rects the app logs with `measureInWindow`
// (`lib/showcase-anchor.ts`). A UIKit bar item is not a React view, so nothing
// can measure it. This draws an invisible, untouchable box where the item sits
// and logs that box instead. The box comes from the bar's geometry (the item
// widths measured in `native-title-bound.ts`, the bar's height from the stack),
// so the video records the real native header. Outside screenshot mode it is a
// component that renders nothing, chosen once at module load like
// `useShowcaseAnchor`.
import type { ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { useFrameSize, useHeaderHeight } from 'expo-router/react-navigation';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useShowcaseAnchor, type ShowcaseAnchorName } from '../../lib/showcase-anchor';
import { NATIVE_BAR_ITEM_WIDTH, nativeTrailingItemLeft } from './native-title-bound';

type NativeTrailingItemShowcaseAnchorProps = {
  name: ShowcaseAnchorName;
  /** How many items in from the trailing edge: 0 is the last item. */
  positionFromEnd: number;
};

function ScreenshotNativeTrailingItemShowcaseAnchor({ name, positionFromEnd }: NativeTrailingItemShowcaseAnchorProps) {
  const anchor = useShowcaseAnchor(name);
  const insets = useSafeAreaInsets();
  // The stack's frame, not the window: on iPad the sidebar takes the leading part.
  const frameWidth = useFrameSize((frame) => frame.width);
  const headerHeight = useHeaderHeight();
  // Bar items sit centred in the bar, which runs from the top inset to the header's bottom.
  const barCentre = insets.top + (headerHeight - insets.top) / 2;
  return (
    <View
      {...anchor}
      collapsable={false}
      pointerEvents="none"
      style={[
        styles.box,
        {
          left: nativeTrailingItemLeft(frameWidth, insets.right, positionFromEnd),
          top: barCentre - NATIVE_BAR_ITEM_WIDTH / 2,
        },
      ]}
    />
  );
}

function NoNativeTrailingItemShowcaseAnchor(_props: NativeTrailingItemShowcaseAnchorProps) {
  return null;
}

export const NativeTrailingItemShowcaseAnchor: (props: NativeTrailingItemShowcaseAnchorProps) => ReactNode =
  process.env.EXPO_PUBLIC_SCREENSHOT_MODE === '1'
    ? ScreenshotNativeTrailingItemShowcaseAnchor
    : NoNativeTrailingItemShowcaseAnchor;

const styles = StyleSheet.create({
  box: { position: 'absolute', width: NATIVE_BAR_ITEM_WIDTH, height: NATIVE_BAR_ITEM_WIDTH },
});
