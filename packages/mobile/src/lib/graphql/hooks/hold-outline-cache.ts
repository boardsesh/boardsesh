/**
 * Pure cache splices for the hold-outline editor's mutations.
 *
 * Their own module, not part of `hooks/index`, for the same reason
 * `use-notifications` is kept out of that barrel: it reaches native modules, so
 * importing it from a test that mocks only the GraphQL client sends Rolldown's
 * scan into react-native's Flow source and fails the whole file. These are
 * plain data transforms and their tests should not have to mock a thing.
 *
 * Why splice at all: the editor's mutations write the React Query cache directly
 * instead of invalidating. The server answers an upsert with the stored row, so
 * the cache can be made exact without a round trip — and a refetch would
 * re-download the config's entire traced shard set on every single save, which
 * on a large Kilter layout is thousands of polygons for a one-placement edit.
 */

import type { HoldOutlineKind } from '@boardsesh/shared-schema';
import type { HoldOutlineOverrideRow, HoldOutlinesQueryResponse } from '../operations';

/**
 * Replace (or add) one override row, keyed by placement AND kind.
 *
 * Both parts of the key matter: a silhouette correction and an LED-ring
 * annotation describe different boundaries of the same hold and coexist, so
 * saving one must not evict the other.
 */
export function withHoldOutlineOverride(
  previous: HoldOutlinesQueryResponse,
  row: HoldOutlineOverrideRow,
): HoldOutlinesQueryResponse {
  const others = previous.holdOutlines.overrides.filter(
    (override) => !(override.placementId === row.placementId && override.kind === row.kind),
  );
  return { holdOutlines: { ...previous.holdOutlines, overrides: [...others, row] } };
}

/**
 * Drop one override row. `kind` is optional on the mutation input and defaults
 * to SILHOUETTE server-side, so it is normalised the same way here — without
 * that, a bare revert would delete the row on the backend and leave it on
 * screen.
 */
export function withoutHoldOutlineOverride(
  previous: HoldOutlinesQueryResponse,
  placementId: number,
  kind: HoldOutlineKind | undefined,
): HoldOutlinesQueryResponse {
  const resolvedKind: HoldOutlineKind = kind ?? 'SILHOUETTE';
  return {
    holdOutlines: {
      ...previous.holdOutlines,
      overrides: previous.holdOutlines.overrides.filter(
        (override) => !(override.placementId === placementId && override.kind === resolvedKind),
      ),
    },
  };
}
