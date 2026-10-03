import { memo, useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { Image } from 'expo-image';
import Svg, { Path } from 'react-native-svg';
import { accumulateFramesToMaps } from '@boardsesh/board-constants/hold-states';
import { GET_SPRAY_WALL_RENDER_DATA } from '@boardsesh/graphql/operations/spray-walls';
import type { SprayWallRenderData } from '@boardsesh/graphql/generated/graphql';
import { OfflineState } from '../OfflineState';
import { Text } from '../Text';
import { placementRingPathData, radiusRingToBoardPx, ringToPathData } from '../outline-editor/stroke';
import { useOfflineQueryState } from '../../hooks/use-offline-query-state';
import { getHttpClient } from '../../lib/graphql/client';
import { mapCanonicalHoldsToPhoto, type SprayPhotoHold } from '../../lib/spray/spray-hold-geometry';
import { photoDimensions, toCanonicalHolds } from '../../lib/spray/spray-wall-loader';
import { useTheme } from '../../providers/theme-provider';
import { spacing } from '../../theme/tokens';

type SprayWallRenderDataResponse = { sprayWallRenderData: SprayWallRenderData | null };

/**
 * The key for ONE past version of a wall.
 *
 * Deliberately not under `sprayWallRenderDataQueryKey(wallUuid)`: that key holds
 * the wall's LIVE payload, and everything that invalidates or refetches it (a
 * reset, an expired photo signature, an account change) ends by re-registering
 * the wall. A past version sharing its prefix would be swept into that.
 */
export const sprayRevisionRenderDataQueryKey = (wallUuid: string, version: number) =>
  ['sprayWallRevisionRenderData', wallUuid, version] as const;

/**
 * Under the photo signature's fifteen minutes, so a sheet left open does not
 * redraw from a URL that has stopped working.
 */
const REVISION_RENDER_DATA_STALE_TIME_MS = 10 * 60 * 1000;

/** Solid ring over a dark halo: the wall behind is a photograph of coloured plastic. */
const RING_WIDTH = 2.5;
const HALO_WIDTH = 5;
const HALO_COLOR = '#000000';
const HALO_OPACITY = 0.55;

type SprayRevisionBoardProps = {
  wallUuid: string;
  /** `ClimbRevisionRow.sprayWallVersionNumber`: the photo this revision was set on. */
  version: number;
  /** The revision's frames, in the same `p<id>r<role>` form as a live climb. */
  frames: string;
};

function ringPath(hold: SprayPhotoHold): string {
  return hold.outline ? ringToPathData(radiusRingToBoardPx([...hold.outline], hold)) : placementRingPathData(hold);
}

/**
 * A revision's holds, grouped by colour into one path string each.
 *
 * Every frame of a route is folded in, later frames winning, so the picture is
 * "every hold this version of the climb uses". A hold the frames name but this
 * wall version does not have is skipped: there is nowhere honest to draw it.
 */
export function buildRevisionRingBuckets(
  frames: string,
  holds: readonly SprayPhotoHold[],
): Array<{ color: string; path: string }> {
  const holdById = new Map<number, SprayPhotoHold>();
  for (const hold of holds) holdById.set(hold.id, hold);

  const colorByHoldId = new Map<number, string>();
  for (const frameMap of accumulateFramesToMaps(frames, 'spray')) {
    for (const [holdId, lit] of Object.entries(frameMap)) {
      colorByHoldId.set(Number(holdId), lit.displayColor || lit.color);
    }
  }

  const pathsByColor = new Map<string, string[]>();
  for (const [holdId, color] of colorByHoldId) {
    const hold = holdById.get(holdId);
    if (!hold) continue;
    const bucket = pathsByColor.get(color);
    if (bucket) bucket.push(ringPath(hold));
    else pathsByColor.set(color, [ringPath(hold)]);
  }
  return [...pathsByColor].map(([color, paths]) => ({ color, path: paths.join('') }));
}

/**
 * A climb revision drawn on the wall photo it was set on, when that is NOT the
 * photo the wall has today (#5955).
 *
 * The live board cannot draw it. The native render path reads the wall from the
 * spray registry, and the registry holds one version per wall: the current one.
 * Putting an old version in there, even for a moment, would swap the photograph
 * and the hold generation under the play drawer this sheet is open on top of,
 * and under every queue thumbnail of that wall.
 *
 * So this fetches the one version itself and draws it itself, and it **never
 * writes the registry**: no `registerRenderData`, no `registerSprayWall`, no
 * `refreshSprayWall`. It only borrows the loader's two pure readers. The photo
 * is an `expo-image` and the holds are one `react-native-svg` layer in the
 * photo's own pixels, the same way `SprayResetSvgLayer` draws a reset.
 *
 * Known limit: plain rings, not the wall's stored look.
 */
export const SprayRevisionBoard = memo(function SprayRevisionBoard({
  wallUuid,
  version,
  frames,
}: SprayRevisionBoardProps) {
  const { t } = useTranslation('climbs');
  const { systemColors } = useTheme();

  const query = useQuery({
    queryKey: sprayRevisionRenderDataQueryKey(wallUuid, version),
    queryFn: () =>
      getHttpClient().request<SprayWallRenderDataResponse>(GET_SPRAY_WALL_RENDER_DATA, { uuid: wallUuid, version }),
    select: (response) => response.sprayWallRenderData ?? null,
    staleTime: REVISION_RENDER_DATA_STALE_TIME_MS,
  });
  const offline = useOfflineQueryState(query);
  const renderData = query.data;

  // Mapped once per payload. `null` when the photo will not say its size or the
  // homography has no inverse: either way the holds cannot be put on the photo.
  const wall = useMemo(() => {
    if (!renderData) return null;
    const dimensions = photoDimensions(renderData);
    const holds = mapCanonicalHoldsToPhoto(renderData.homography, toCanonicalHolds(renderData));
    if (!dimensions || !holds) return null;
    return { ...dimensions, holds, photoUrl: renderData.photo.url };
  }, [renderData]);

  const buckets = useMemo(() => (wall ? buildRevisionRingBuckets(frames, wall.holds) : []), [frames, wall]);
  const imageSource = useMemo(() => (wall ? { uri: wall.photoUrl } : null), [wall]);

  // No connection is not "the photo is gone", and must not be said as if it were.
  if (offline.isBlocked && offline.reason) {
    return <OfflineState reason={offline.reason} onRetry={query.refetch} style={styles.placard} />;
  }
  if (query.isPending) {
    return <View style={[styles.pending, { backgroundColor: systemColors.tertiaryBackground }]} />;
  }
  if (!wall || !imageSource) {
    return (
      <Text variant="footnote" color={systemColors.secondaryLabel} style={styles.unavailable}>
        {t('mobile.revisions.sheet.photoUnavailable')}
      </Text>
    );
  }

  return (
    <View
      style={[
        styles.board,
        { aspectRatio: wall.width / wall.height, backgroundColor: systemColors.tertiaryBackground },
      ]}
      accessible
      accessibilityRole="image"
      accessibilityLabel={t('mobile.revisions.sheet.boardLabel')}
    >
      {/* Memory only: the URL is a 15-minute signature over a private photo. */}
      <Image source={imageSource} style={StyleSheet.absoluteFill} contentFit="contain" cachePolicy="memory" />
      <Svg
        pointerEvents="none"
        style={StyleSheet.absoluteFill}
        width="100%"
        height="100%"
        viewBox={`0 0 ${wall.width} ${wall.height}`}
      >
        {buckets.map((bucket) => (
          <Path
            key={`halo-${bucket.color}`}
            d={bucket.path}
            fill="none"
            stroke={HALO_COLOR}
            strokeOpacity={HALO_OPACITY}
            strokeWidth={HALO_WIDTH}
            vectorEffect="non-scaling-stroke"
          />
        ))}
        {buckets.map((bucket) => (
          <Path
            key={bucket.color}
            d={bucket.path}
            fill="none"
            stroke={bucket.color}
            strokeWidth={RING_WIDTH}
            vectorEffect="non-scaling-stroke"
          />
        ))}
      </Svg>
    </View>
  );
});

const styles = StyleSheet.create({
  board: {
    width: '100%',
    overflow: 'hidden',
  },
  pending: {
    width: '100%',
    aspectRatio: 1,
  },
  placard: {
    paddingVertical: spacing[6],
  },
  unavailable: {
    paddingVertical: spacing[3],
  },
});
