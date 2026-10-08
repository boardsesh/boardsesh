import { Host, Slider } from '@expo/ui/jetpack-compose';
import type { NativeMarkerSliderProps } from './NativeMarkerSlider.types';
export function NativeMarkerSlider({
  accessibilityLabel: _label,
  color,
  step,
  onValueChangeEnd,
  ...props
}: NativeMarkerSliderProps) {
  return (
    <Host style={{ height: 48, alignSelf: 'stretch' }}>
      <Slider
        {...props}
        steps={Math.max(0, Math.round((props.max - props.min) / step) - 1)}
        onValueChangeFinished={onValueChangeEnd}
        colors={{ thumbColor: color, activeTrackColor: color }}
      />
    </Host>
  );
}
