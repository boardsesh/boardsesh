import { useMemo } from 'react';
import {
  getBoardAngleOptions,
  getBoardAngleSnapOptions,
  getBoardCapabilities,
  normalizeBoardCatalogAngles,
} from '@boardsesh/board-config';
import type { BoardName } from '@boardsesh/shared-schema';
import { useAngles } from '../lib/graphql/hooks';

/** Query-backed and bundled angle catalogues have the same consumer shape.
 * The optional bundled ladder keeps existing feature-flag callers compatible. */
export function useBoardAngleState(
  boardName: BoardName | undefined,
  {
    layoutId,
    enabled = true,
    bundledAngles,
    currentAngle,
  }: {
    layoutId?: number | null;
    enabled?: boolean;
    bundledAngles?: readonly number[];
    currentAngle?: number;
  } = {},
) {
  const requiresCatalog = getBoardCapabilities(boardName).angleOptionsSource === 'catalog';
  const hasLayout = layoutId != null && layoutId > 0;
  const queryEnabled = requiresCatalog && enabled && hasLayout;
  const query = useAngles(boardName ?? '', layoutId ?? 0, queryEnabled);
  const angles = useMemo(
    () =>
      requiresCatalog
        ? normalizeBoardCatalogAngles(query.isSuccess && hasLayout ? (query.data ?? []).map(({ angle }) => angle) : [])
        : bundledAngles
          ? [...bundledAngles]
          : boardName
            ? (getBoardAngleOptions(boardName, false) ?? [])
            : [],
    [requiresCatalog, hasLayout, query.isSuccess, query.data, bundledAngles, boardName],
  );
  const snapAngles = useMemo(() => getBoardAngleSnapOptions(boardName, angles), [boardName, angles]);
  const ready = angles.length > 0 && (!requiresCatalog || query.isSuccess);
  const loading = requiresCatalog && queryEnabled && (query.isPending || query.isFetching);
  const fallbackAngle =
    requiresCatalog && ready && currentAngle != null && !angles.includes(currentAngle) ? angles[0] : currentAngle;
  return { angles, snapAngles, ready, loading, requiresCatalog, fallbackAngle };
}
