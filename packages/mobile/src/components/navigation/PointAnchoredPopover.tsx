import { StyleSheet, View } from 'react-native';
import { AnchoredPopover } from './AnchoredPopover';
import type { AnchoredPopoverProps, WindowAnchorPoint } from './AnchoredPopover.types';

/** The 1pt native trigger sits at the measured hold or accessible row location. */
export function PointAnchoredPopover({
  point,
  content,
  visible,
  onClose,
  width,
}: Omit<AnchoredPopoverProps, 'trigger'> & { point: WindowAnchorPoint }) {
  return (
    <View pointerEvents="box-none" style={StyleSheet.absoluteFill}>
      <View pointerEvents="box-none" style={{ position: 'absolute', left: point.x, top: point.y }}>
        <AnchoredPopover
          visible={visible}
          onClose={onClose}
          content={content}
          width={width}
          trigger={
            <View
              style={{ width: 1, height: 1 }}
              accessibilityElementsHidden
              importantForAccessibility="no-hide-descendants"
            />
          }
        />
      </View>
    </View>
  );
}
