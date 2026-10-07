// "Holds only" in the browser. `@react-native-masked-view/masked-view`'s web
// build renders only its mask element, so the native file's approach would
// paint the hold outlines as black blobs. A browser masks natively: the same
// two strokes as an SVG data URI in CSS `mask-image` (`lookPreviewMaskSvgDataUri`).

import { memo, useMemo } from 'react';
import { View, type ViewStyle } from 'react-native';
import { lookPreviewMaskSvgDataUri } from '../../lib/spray/spray-look-preview';
import { FlattenedSprayPhoto } from './FlattenedSprayPhoto';
import type { HoldMaskedPhotoProps } from './HoldMaskedPhoto';

export const HoldMaskedPhoto = memo(function HoldMaskedPhoto({ source, photoUri, tile, mask }: HoldMaskedPhotoProps) {
  const maskStyle = useMemo(() => {
    const image = `url("${lookPreviewMaskSvgDataUri(mask, tile)}")`;
    // CSS-only keys React Native's types do not know; react-native-web passes
    // them through to the element's style.
    return {
      width: tile.width,
      height: tile.height,
      maskImage: image,
      WebkitMaskImage: image,
      maskSize: '100% 100%',
      WebkitMaskSize: '100% 100%',
      maskRepeat: 'no-repeat',
      WebkitMaskRepeat: 'no-repeat',
    } as unknown as ViewStyle;
  }, [mask, tile]);
  return (
    <View style={maskStyle} testID="spray-holds-css-mask">
      <FlattenedSprayPhoto source={source} photoUri={photoUri} tile={tile} />
    </View>
  );
});
