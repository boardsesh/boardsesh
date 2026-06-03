import { useMemo } from 'react';
import { View, StyleSheet } from 'react-native';
import { Image } from 'expo-image';
import { getMoonBoardDetails } from '@boardsesh/board-config';
import { BOARD_BACKGROUND_ASSETS } from '../../lib/board-backgrounds-manifest';

type MoonBoardBackgroundProps = {
  layoutId: number;
  setIds: number[];
};

/**
 * Translate an `images_to_holds` key from `getMoonBoardDetails()` into the
 * bundled-asset manifest key. MoonBoard keys are `moonboard-bg.png` and
 * `{layoutFolder}/{setImageFile}` (always `.png`); the manifest stores the
 * bundled `.webp` variants prefixed with `moonboard/`.
 */
function manifestKeyForMoonBoardImage(imagesToHoldsKey: string): string {
  return `moonboard/${imagesToHoldsKey.replace(/\.png$/, '.webp')}`;
}

/**
 * Stacked MoonBoard board background for the no-SVG create editor: the base
 * board photo first, then each selected hold-set overlay on top. Bundled
 * `.webp` assets are rendered straight from the Metro require() module ids in
 * the background manifest (no disk materialization needed), `contentFit="contain"`
 * so they line up with the aspect-ratio-locked board container. The set overlays
 * are transparent PNGs, so they composite cleanly over the base photo.
 */
export function MoonBoardBackground({ layoutId, setIds }: MoonBoardBackgroundProps) {
  const assets = useMemo(() => {
    let imagesToHoldsKeys: string[];
    try {
      imagesToHoldsKeys = Object.keys(getMoonBoardDetails({ layout_id: layoutId, set_ids: setIds }).images_to_holds);
    } catch {
      imagesToHoldsKeys = [];
    }
    return imagesToHoldsKeys
      .map((key) => ({ key, moduleId: BOARD_BACKGROUND_ASSETS[manifestKeyForMoonBoardImage(key)] }))
      .filter((entry): entry is { key: string; moduleId: number } => entry.moduleId !== undefined);
  }, [layoutId, setIds]);

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none">
      {assets.map(({ key, moduleId }) => (
        <Image key={key} source={moduleId} style={styles.layer} contentFit="contain" cachePolicy="memory-disk" />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  layer: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
  },
});
