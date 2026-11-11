import { Image, StyleSheet, Text, View } from 'react-native';
import { BOKEH_DRIFT, BOKEH_GLIDE_MS, BOKEH_SWELL, FROST_ALPHA, GRAIN_ALPHA } from '@boardsesh/frosted-bokeh';
import grainSource from '@boardsesh/frosted-bokeh/grain.png';
import { StorySurface, StoryVariant } from '../dev/stories/StoryCanvas';
import type { StoryModule } from '../dev/stories/types';
import { NativeFrostedBokehGPU } from '../../modules/frosted-bokeh-gpu/src/index';
import { useTheme } from '../providers/theme-provider';
import { spacing } from '../theme/tokens';
import { FrostedBokeh } from './FrostedBokeh';
import { useWallGlowLayer, type WallGlowInput } from './play-drawer/use-wall-glow';

// Parity: the same frost drawn by React Native views and by the Metal shader,
// held still, so the two renderers can be compared pixel for pixel in both
// schemes. Overlapping lights of different colours are where they can differ.

const WIDTH = 343;
const HEIGHT = 44;

const OVERLAPPING: WallGlowInput = {
  key: 'frosted-bokeh-parity',
  holds: [
    { x: 50, y: 20, color: '#FF0000' },
    { x: 55, y: 30, color: '#00DD00' },
    { x: 45, y: 70, color: '#4DF5FD' },
    { x: 52, y: 78, color: '#FF00FF' },
    { x: 50, y: 120, color: '#FFA500' },
    { x: 48, y: 130, color: '#00DD00' },
  ],
  boardWidth: 100,
  boardHeight: 150,
};

function Parity() {
  const { colorScheme } = useTheme();
  const layer = useWallGlowLayer(OVERLAPPING, WIDTH, HEIGHT, colorScheme === 'dark' ? 'dark' : 'light');
  if (!layer) return null;
  return (
    <View style={styles.stack}>
      <StoryVariant label="React Native views (today)">
        <StorySurface>
          <View style={styles.pill}>
            <FrostedBokeh layer={layer} />
          </View>
        </StorySurface>
      </StoryVariant>
      <StoryVariant label="Metal shader, held still">
        <StorySurface>
          <View style={[styles.pill, { backgroundColor: layer.surface.base }]}>
            {NativeFrostedBokehGPU ? (
              <NativeFrostedBokehGPU
                style={StyleSheet.absoluteFill}
                blobs={layer.blobs.map(({ x, y, r, peak, color }) => ({
                  x,
                  y,
                  r,
                  peak: peak * layer.opacityScale,
                  color,
                }))}
                base={layer.surface.base}
                blend={layer.blend}
                layerKey={layer.key}
                reduceMotion
                drift={BOKEH_DRIFT}
                swell={BOKEH_SWELL}
                glideMs={BOKEH_GLIDE_MS}
              />
            ) : (
              <Text>This binary has no Metal frost.</Text>
            )}
            {/* The frost and grain FrostedBokeh draws over either renderer. */}
            {layer.surface.frost ? <View style={[StyleSheet.absoluteFill, styles.frost]} /> : null}
            <Image source={grainSource} resizeMode="repeat" style={[StyleSheet.absoluteFill, styles.grain]} />
          </View>
        </StorySurface>
      </StoryVariant>
    </View>
  );
}

const stories: StoryModule = {
  title: 'Frosted bokeh / Renderer parity',
  stories: {
    parity: {
      name: 'React Native vs Metal, still, overlapping lights',
      render: () => <Parity />,
    },
  },
};

export default stories;

const styles = StyleSheet.create({
  stack: {
    gap: spacing[5],
  },
  frost: {
    backgroundColor: `rgba(255, 255, 255, ${FROST_ALPHA})`,
  },
  grain: {
    opacity: GRAIN_ALPHA,
    width: '100%',
    height: '100%',
  },
  pill: {
    width: WIDTH,
    height: HEIGHT,
    borderRadius: HEIGHT / 2,
    overflow: 'hidden',
  },
});
