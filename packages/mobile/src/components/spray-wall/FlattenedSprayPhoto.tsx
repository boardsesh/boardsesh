// A spray wall photo flattened into a preview tile, on the phone: what "Wall
// only" will look like before the backend has made it (`docs/spray-walls.md`,
// "Previewing a look on the phone").
//
// Two renderers behind one component, because the platforms disagree on what a
// view transform can do:
//
// - iOS and the browser apply a view's full 4x4 matrix, perspective row
//   included, so the photo is ONE image in a view transformed by the exact
//   homography (`perspectiveViewMatrix`).
// - Android does not: React Native decomposes the matrix into translate,
//   rotate, scale and camera distance before the view sees it, which drops the
//   perspective row and any skew. There the tile is a mesh of triangles, each
//   clipping the photo drawn under an SVG affine transform that matches the
//   homography at its corners (`affinePreviewMesh`). SVG keeps the whole affine.
//
// The photo is always the LOCAL copy in the spray photo cache on native
// (`useSprayLookPreviewPhoto`), never the presigned URL: react-native-svg's
// Android image loader keeps a disk cache for anything it fetches over the
// network, and a private wall's photo must not land in a cache nothing clears.
// The mesh refuses anything that is not a `file:///` URI, which is also the
// condition of this file's exemption from `check:mobile-board-art-network`
// (`scripts/mobile-board-art-network-check.ts`).
//
// Static: no state, no animation, and every number is memoised off the tile
// size and the source, so a picker re-render costs nothing here.

import { memo, useId, useMemo } from 'react';
import { Platform, StyleSheet, View, type ViewStyle } from 'react-native';
import { Image } from 'expo-image';
import Svg, { ClipPath, Defs, G, Image as SvgImage, Polygon } from 'react-native-svg';
import {
  affinePreviewMesh,
  perspectiveViewMatrix,
  photoToTileHomography,
  type PreviewMeshTriangle,
  type ReferenceSize,
} from '@boardsesh/spray-wall-geometry';
import { isLocalFileUri, type SprayLookPreviewSource } from '../../lib/spray/spray-look-preview';

export type FlattenedSprayPhotoProps = {
  source: SprayLookPreviewSource;
  /** Where to load the photo: a `file:///` URI on native, the presigned URL in a browser. */
  photoUri: string;
  tile: ReferenceSize;
};

/**
 * Photo points per tile point the iOS view is laid out at, relative to the
 * frame's own scale. Above 1 so the far side of a keystoned photo, which is
 * stretched on the way into the tile, still has pixels to stretch.
 */
const LAYOUT_OVERSAMPLE = 1.5;

/** Points each Android triangle is grown by, so the anti-aliased clip edges overlap instead of leaving a hairline. */
const TRIANGLE_BLEED = 0.6;

/**
 * The 16-number matrix as each renderer wants it. React Native takes it as
 * `matrix` on iOS. React Native Web copies the key into CSS verbatim, and CSS
 * `matrix()` takes 6 numbers, so the browser needs `matrix3d` (same column-major
 * order, same centre origin).
 */
function viewTransform(matrix: number[]): ViewStyle['transform'] {
  if (Platform.OS === 'web') return [{ matrix3d: matrix } as unknown as { matrix: number[] }];
  return [{ matrix }];
}

function MatrixFlattenedPhoto({ source, photoUri, tile }: FlattenedSprayPhotoProps) {
  const { layoutStyle, imageSource } = useMemo(() => {
    const photoToTile = photoToTileHomography(source.homography, source.frame, tile);
    const scale = Math.min(1, (LAYOUT_OVERSAMPLE * tile.width) / source.frame.width);
    const layout = { width: source.photo.width * scale, height: source.photo.height * scale };
    return {
      layoutStyle: {
        width: layout.width,
        height: layout.height,
        transform: viewTransform(perspectiveViewMatrix(photoToTile, source.photo, layout)),
      },
      imageSource: { uri: photoUri },
    };
  }, [source, photoUri, tile]);
  return (
    <View style={[styles.photoLayer, layoutStyle]}>
      <Image
        source={imageSource}
        style={StyleSheet.absoluteFill}
        contentFit="fill"
        // Memory only: a private wall's photo, and nothing clears the disk
        // cache on sign-out.
        cachePolicy="memory"
        accessible={false}
      />
    </View>
  );
}

function grownPoints(points: PreviewMeshTriangle['points']): string {
  const centreX = (points[0] + points[2] + points[4]) / 3;
  const centreY = (points[1] + points[3] + points[5]) / 3;
  const out: string[] = [];
  for (let index = 0; index < 6; index += 2) {
    const dx = points[index] - centreX;
    const dy = points[index + 1] - centreY;
    const length = Math.hypot(dx, dy) || 1;
    out.push(
      `${(points[index] + (dx / length) * TRIANGLE_BLEED).toFixed(2)},${(points[index + 1] + (dy / length) * TRIANGLE_BLEED).toFixed(2)}`,
    );
  }
  return out.join(' ');
}

function MeshFlattenedPhoto({ source, photoUri, tile }: FlattenedSprayPhotoProps) {
  // SVG ids are document-wide on the web, so each tile gets its own prefix.
  const idPrefix = `spray-mesh-${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
  const triangles = useMemo(() => {
    const mesh = affinePreviewMesh(photoToTileHomography(source.homography, source.frame, tile), tile);
    return (mesh?.triangles ?? []).map(({ points, matrix }) => ({
      polygon: grownPoints(points),
      transform: `matrix(${matrix.map((value) => value.toFixed(6)).join(' ')})`,
    }));
  }, [source, tile]);
  // Local files only: see the header. A remote URL here would land in
  // react-native-svg's disk cache.
  if (!isLocalFileUri(photoUri)) return null;
  if (triangles.length === 0) return null;
  return (
    <Svg width={tile.width} height={tile.height} style={StyleSheet.absoluteFill}>
      <Defs>
        {triangles.map(({ polygon }, index) => (
          <ClipPath key={index} id={`${idPrefix}-${index}`}>
            <Polygon points={polygon} />
          </ClipPath>
        ))}
      </Defs>
      {triangles.map(({ transform }, index) => (
        <G key={index} clipPath={`url(#${idPrefix}-${index})`}>
          <SvgImage
            href={photoUri}
            width={source.photo.width}
            height={source.photo.height}
            preserveAspectRatio="none"
            transform={transform}
          />
        </G>
      ))}
    </Svg>
  );
}

export const FlattenedSprayPhoto = memo(function FlattenedSprayPhoto({
  source,
  photoUri,
  tile,
}: FlattenedSprayPhotoProps) {
  const clipStyle = useMemo(() => [styles.clip, { width: tile.width, height: tile.height }], [tile]);
  return (
    <View style={clipStyle} pointerEvents="none">
      {Platform.OS === 'android' ? (
        <MeshFlattenedPhoto source={source} photoUri={photoUri} tile={tile} />
      ) : (
        <MatrixFlattenedPhoto source={source} photoUri={photoUri} tile={tile} />
      )}
    </View>
  );
});

const styles = StyleSheet.create({
  clip: {
    overflow: 'hidden',
  },
  photoLayer: {
    position: 'absolute',
    left: 0,
    top: 0,
  },
});
