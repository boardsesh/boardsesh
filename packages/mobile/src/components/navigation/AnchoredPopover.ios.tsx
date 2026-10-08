import { Host } from '@expo/ui';
import { Popover, RNHostView } from '@expo/ui/swift-ui';
import { View } from 'react-native';
import type { AnchoredPopoverProps } from './AnchoredPopover.types';

/** UIKit positions and dismisses the popover relative to its actual control. */
export function AnchoredPopover({ visible, onClose, trigger, content, width = 360 }: AnchoredPopoverProps) {
  return (
    <Host matchContents>
      <Popover
        isPresented={visible}
        attachmentAnchor="bottom"
        arrowEdge="top"
        onIsPresentedChange={(presented) => {
          if (!presented) onClose();
        }}
      >
        <Popover.Trigger>
          <RNHostView matchContents>{trigger}</RNHostView>
        </Popover.Trigger>
        <Popover.Content>
          <RNHostView matchContents>
            <View style={{ width }}>{content}</View>
          </RNHostView>
        </Popover.Content>
      </Popover>
    </Host>
  );
}
