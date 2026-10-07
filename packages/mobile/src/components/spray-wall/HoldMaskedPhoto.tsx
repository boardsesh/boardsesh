// "Holds only" on the phone: the flattened photo, shown only where the holds
// are. Native masks with `MaskedView` and an SVG of the hold outlines; the
// browser has its own file (`HoldMaskedPhoto.web.tsx`), because
// `@react-native-masked-view/masked-view` on the web renders the mask element
// and DROPS the children, which draws the mask itself as black blobs.

import { memo, useMemo } from 'react';
import MaskedView from '@react-native-masked-view/masked-view';
import Svg, { Path } from 'react-native-svg';
import type { ReferenceSize } from '@boardsesh/spray-wall-geometry';
import {
  LOOK_PREVIEW_FEATHER_OPACITY,
  type LookPreviewMask,
  type SprayLookPreviewSource,
} from '../../lib/spray/spray-look-preview';
import { FlattenedSprayPhoto } from './FlattenedSprayPhoto';

export type HoldMaskedPhotoProps = {
  source: SprayLookPreviewSource;
  photoUri: string;
  tile: ReferenceSize;
  mask: LookPreviewMask;
};

export const HoldMaskedPhoto = memo(function HoldMaskedPhoto({ source, photoUri, tile, mask }: HoldMaskedPhotoProps) {
  const sizeStyle = useMemo(() => ({ width: tile.width, height: tile.height }), [tile]);
  return (
    <MaskedView
      style={sizeStyle}
      maskElement={
        <Svg width={tile.width} height={tile.height}>
          {/* The job feathers its mask with a Gaussian blur; a soft, wider
              stroke under the hard edge is the cheap stand-in. */}
          <Path
            d={mask.path}
            fill="#000"
            stroke="#000"
            strokeOpacity={LOOK_PREVIEW_FEATHER_OPACITY}
            strokeWidth={2 * (mask.grow + mask.feather)}
            strokeLinejoin="round"
          />
          <Path d={mask.path} fill="#000" stroke="#000" strokeWidth={2 * mask.grow} strokeLinejoin="round" />
        </Svg>
      }
    >
      <FlattenedSprayPhoto source={source} photoUri={photoUri} tile={tile} />
    </MaskedView>
  );
});
