/** Reports native bar-item geometry only when a layout observer is installed. */
import { StyleSheet, View } from 'react-native';
import { useFrameSize, useHeaderHeight } from 'expo-router/react-navigation';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useShowcaseAnchor, useLayoutObserverEnabled, type ShowcaseAnchorName } from '../../lib/showcase-anchor';
import { NATIVE_BAR_ITEM_WIDTH, nativeTrailingItemLeft } from './native-title-bound';

type NativeTrailingItemShowcaseAnchorProps = {
  name: ShowcaseAnchorName;
  /** How many items in from the trailing edge: 0 is the last item. */
  positionFromEnd: number;
};

function MeasuredNativeTrailingItem({ name, positionFromEnd }: NativeTrailingItemShowcaseAnchorProps) {
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

export function NativeTrailingItemShowcaseAnchor(props: NativeTrailingItemShowcaseAnchorProps) {
  const enabled = useLayoutObserverEnabled();
  return enabled ? <MeasuredNativeTrailingItem {...props} /> : null;
}

const styles = StyleSheet.create({
  box: { position: 'absolute', width: NATIVE_BAR_ITEM_WIDTH, height: NATIVE_BAR_ITEM_WIDTH },
});
