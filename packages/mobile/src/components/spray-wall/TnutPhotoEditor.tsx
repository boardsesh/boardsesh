import { useMemo } from 'react';
import { View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { runOnJS } from 'react-native-reanimated';
import Svg, { Path } from 'react-native-svg';
import { useTranslation } from 'react-i18next';
import type { TnutPoint } from '@boardsesh/spray-wall-geometry';
import { useTheme } from '../../providers/theme-provider';
import { fitCornerPhoto } from './corner-photo-fit';
import { FlattenedSprayPhoto } from './FlattenedSprayPhoto';
import type { SprayLookPreviewSource } from '../../lib/spray/spray-look-preview';

export function TnutPhotoEditor({
  source,
  photoUri,
  holes,
  maxWidth,
  maxHeight,
  onTap,
}: {
  source: SprayLookPreviewSource;
  photoUri: string;
  holes: TnutPoint[];
  maxWidth: number;
  maxHeight: number;
  onTap: (point: TnutPoint, width: number, height: number) => void;
}) {
  const { t } = useTranslation('boards');
  const { brandColors } = useTheme();
  const fit = fitCornerPhoto({
    boxWidth: maxWidth,
    boxHeight: maxHeight,
    photoWidth: source.frame.width,
    photoHeight: source.frame.height,
  });
  const width = fit?.width ?? 0;
  const height = fit?.height ?? 0;
  const tap = useMemo(
    () =>
      Gesture.Tap().onEnd((event, success) => {
        if (success && width > 0 && height > 0) {
          runOnJS(onTap)(
            { x: Math.max(0, Math.min(1, event.x / width)), y: Math.max(0, Math.min(1, event.y / height)) },
            width,
            height,
          );
        }
      }),
    [onTap, width, height],
  );
  const path = useMemo(
    () =>
      holes
        .map(({ x, y }) => {
          const centerX = x * width;
          const centerY = y * height;
          return `M${centerX - 4},${centerY}a4,4 0 1,0 8,0a4,4 0 1,0 -8,0`;
        })
        .join(''),
    [holes, width, height],
  );
  if (!fit) return null;
  return (
    <GestureDetector gesture={tap}>
      <View style={{ width, height }} accessibilityLabel={t('sprayLedSetup.photoLabel')}>
        <FlattenedSprayPhoto source={source} photoUri={photoUri} tile={fit} />
        <Svg width={width} height={height} pointerEvents="none" style={{ position: 'absolute' }}>
          <Path d={path} fill={brandColors.primary} stroke={brandColors.onPrimary} strokeWidth={1.5} />
        </Svg>
      </View>
    </GestureDetector>
  );
}
