import NativeMaskedView from '@react-native-masked-view/masked-view';
import type { ComponentType, ReactElement } from 'react';
import type { ViewProps } from 'react-native';

type MaskedViewProps = ViewProps & {
  maskElement: ReactElement;
  androidRenderingMode?: 'software' | 'hardware';
};

// The package's declaration extends NativeMethods, removed in RN 0.88.
// Its runtime component still has the same native View and mask props.
export const MaskedView = NativeMaskedView as unknown as ComponentType<MaskedViewProps>;
