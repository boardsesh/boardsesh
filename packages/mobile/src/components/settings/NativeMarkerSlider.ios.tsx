import { Host, Slider } from '@expo/ui/swift-ui';
import { accessibilityLabel, tint } from '@expo/ui/swift-ui/modifiers';
import type { NativeMarkerSliderProps } from './NativeMarkerSlider.types';
export function NativeMarkerSlider({
  accessibilityLabel: label,
  color,
  onValueChangeEnd,
  ...props
}: NativeMarkerSliderProps) {
  return (
    <Host matchContents={{ vertical: true }} style={{ minHeight: 44 }}>
      <Slider
        {...props}
        onEditingChanged={(editing) => {
          if (!editing) onValueChangeEnd();
        }}
        modifiers={[accessibilityLabel(label), tint(color)]}
      />
    </Host>
  );
}
