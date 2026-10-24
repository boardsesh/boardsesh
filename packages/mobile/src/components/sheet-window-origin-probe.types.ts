import type { StyleProp, ViewStyle } from 'react-native';

/** A frame SwiftUI reported for the probe, in `.global` coordinates. */
export type SheetWindowFrame = { x: number; y: number; width: number; height: number };

export type SheetWindowOriginProbeProps = {
  onFrame: (frame: SheetWindowFrame) => void;
  style: StyleProp<ViewStyle>;
};
