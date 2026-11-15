import { useCallback, useEffect, useMemo, useState } from 'react';
import { StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import { Asset } from 'expo-asset';
import { HOLD_STATE_MAP } from '@boardsesh/board-constants/hold-states';
import { renderHoldsOverlay } from '../../../modules/board-renderer/src';
import { LayeredClimbImage } from '../../components/LayeredClimbImage';
import type { StorySprayGeometry } from '../fixtures/boards';
import type { StoryRenderControls } from './types';
const photos = {
  'spray-liz': require('../fixtures/spray/spray-liz.jpg'),
  'spray-cherry': require('../fixtures/spray/spray-cherry.jpg'),
  'spray-bowlo': require('../fixtures/spray/spray-bowlo.jpg'),
};
export function sprayStoryPhoto(id: StorySprayGeometry['photoId']) {
  return Asset.fromModule(photos[id]);
}
/** The same native overlay renderer and photo/holds presentation used by BoardImageNative,
 * with geometry injected directly instead of loading a user's wall into the live registry. */
export function StorySprayBoard({
  geometry,
  frames,
  mirrored = false,
  onReady,
  onError,
}: { geometry: StorySprayGeometry; frames: string; mirrored?: boolean } & StoryRenderControls) {
  const [bounds, setBounds] = useState({ width: 0, height: 0 });
  const [photo, setPhoto] = useState<string | null>(null);
  const [overlay, setOverlay] = useState<{ frames: string; uri: string } | null>(null);
  const config = useMemo(
    () =>
      JSON.stringify({
        board_width: geometry.width,
        board_height: geometry.height,
        output_width: geometry.width,
        mirrored: false,
        thumbnail: false,
        stroke_width_multiplier: 1,
        shape_size_multiplier: 1,
        holds: geometry.holds.map(({ id, cx, cy, r }) => ({ id, cx, cy, r, mirroredHoldId: null })),
        hold_state_map: Object.fromEntries(
          Object.entries(HOLD_STATE_MAP.spray).map(([code, role]) => [
            code,
            { color: role.displayColor ?? role.color, ...(role.renderStyle ? { render_style: role.renderStyle } : {}) },
          ]),
        ),
        frames,
      }),
    [geometry, frames],
  );
  useEffect(() => {
    let cancelled = false;
    const asset = sprayStoryPhoto(geometry.photoId);
    void asset.downloadAsync().then(() => {
      if (!cancelled) setPhoto(asset.localUri ?? asset.uri);
    }, onError);
    return () => {
      cancelled = true;
    };
  }, [geometry.photoId, onError]);
  useEffect(() => {
    let cancelled = false;
    // A deterministic content hash namespaces this dev-only render away from the live overlay cache.
    let hash = 2166136261;
    for (let index = 0; index < config.length; index++) hash = Math.imul(hash ^ config.charCodeAt(index), 16777619);
    void renderHoldsOverlay(config, `story-${geometry.photoId}-${(hash >>> 0).toString(16)}`).then((uri) => {
      if (!cancelled) setOverlay({ frames, uri });
    }, onError);
    return () => {
      cancelled = true;
    };
  }, [config, frames, geometry.photoId, onError]);
  const onLayout = useCallback(
    ({ nativeEvent: { layout } }: LayoutChangeEvent) =>
      setBounds((previous) =>
        previous.width === layout.width && previous.height === layout.height
          ? previous
          : { width: layout.width, height: layout.height },
      ),
    [],
  );
  const scale = Math.min(bounds.width / geometry.width, bounds.height / geometry.height);
  const backgrounds = useMemo(() => (photo ? [photo] : []), [photo]);
  return (
    <View style={styles.root} onLayout={onLayout}>
      {scale > 0 && photo && overlay?.frames === frames ? (
        <View style={{ width: geometry.width * scale, height: geometry.height * scale }}>
          <LayeredClimbImage
            backgroundPaths={backgrounds}
            overlayUri={overlay.uri}
            overlayLoadKey={overlay.uri}
            mirrored={mirrored}
            suppressOverlayTransition
            onArtDisplayed={onReady}
            onArtError={onError}
          />
        </View>
      ) : null}
    </View>
  );
}
const styles = StyleSheet.create({ root: { flex: 1, alignItems: 'center', justifyContent: 'center' } });
