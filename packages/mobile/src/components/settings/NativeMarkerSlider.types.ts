export type NativeMarkerSliderProps = {
  value: number;
  min: number;
  max: number;
  step: number;
  accessibilityLabel: string;
  color: string;
  onValueChange: (value: number) => void;
  onValueChangeEnd: () => void;
};
