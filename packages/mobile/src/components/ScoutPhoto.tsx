import { type ComponentProps } from 'react';
import { Image } from 'expo-image';

// The Scout easter-egg photo (EXIF-stripped). Kept behind a component so the
// static asset require lives in one place and screens/tests never touch the jpg.
const SCOUT_PHOTO = require('../../assets/scout.jpg');

type ScoutPhotoProps = {
  style?: ComponentProps<typeof Image>['style'];
};

export function ScoutPhoto({ style }: ScoutPhotoProps) {
  return <Image source={SCOUT_PHOTO} style={style} contentFit="cover" accessibilityIgnoresInvertColors />;
}
