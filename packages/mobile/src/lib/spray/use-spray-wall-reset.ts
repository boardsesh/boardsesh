// The two calls a reset is made of, plus the one remix reads (epic #5346, SW-13).
//
// They are split the way the server splits them, which is by what they write:
//
//  - `proposeSprayWallReset` is a QUERY and writes nothing at all. It is a
//    `useQuery` rather than a mutation for exactly that reason — the compare
//    screen may be re-entered, the app may be backgrounded, and re-asking costs
//    a read.
//  - `commitSprayWallVersion` is the one call that lands a new generation of the
//    wall, in one transaction under the wall lock. A mutation, never retried
//    automatically: a reset that appears to have failed may have landed, and a
//    silent second attempt would be re-validated against a wall it has already
//    changed.
//  - `remixClimb` writes nothing either. It hands back a starting point.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  COMMIT_SPRAY_WALL_VERSION,
  DISCARD_SPRAY_WALL_VERSION,
  GET_SPRAY_WALL_WITH_VERSIONS,
  PROPOSE_SPRAY_WALL_RESET,
  REMIX_CLIMB,
} from '@boardsesh/graphql/operations/spray-walls';
import type {
  CommitSprayWallVersionInput,
  ProposeSprayWallResetInput,
  SprayRemixSeed,
  SprayWall,
  SprayWallResetProposal,
  SprayWallResetResult,
} from '@boardsesh/graphql/generated/graphql';
import { getHttpClient } from '../graphql/client';
import { invalidateSprayWallRenderData } from './spray-wall-loader';
import { mySprayWallsQueryKey } from './use-create-spray-wall';

type ProposeResponse = { proposeSprayWallReset: SprayWallResetProposal | null };
type CommitResponse = { commitSprayWallVersion: SprayWallResetResult };
type RemixResponse = { remixClimb: SprayRemixSeed | null };
type WallWithVersionsResponse = { sprayWall: SprayWall | null };
type DiscardResponse = { discardSprayWallVersion: boolean };

/**
 * Keyed on the draft version and how many detections were sent.
 *
 * Not on the detections themselves: they are derived deterministically from the
 * draft's photo and homography, so for one `versionId` the array is the same
 * array — and hashing a thousand circles on every render to prove it would cost
 * more than the request.
 */
export const sprayWallResetProposalQueryKey = (versionId: string | null, detectionCount: number) =>
  ['sprayWallResetProposal', versionId, detectionCount] as const;

/**
 * Ask what this reset would do.
 *
 * `detections` must already be in the wall's CANONICAL frame — see
 * `buildResetDetections`. The server never warps an image and never re-runs
 * detection: it is the owner's wall, and what it decides is a question about two
 * coordinate sets.
 *
 * A draft with no anchors is refused (`SPRAY_WALL_ANCHORS_REQUIRED`). The flow
 * cannot produce one, but the error is surfaced rather than swallowed, because a
 * draft resumed from an older build might.
 */
export function useSprayWallResetProposal(input: ProposeSprayWallResetInput | null) {
  return useQuery({
    queryKey: sprayWallResetProposalQueryKey(input?.versionId ?? null, input?.detections.length ?? 0),
    queryFn: async (): Promise<SprayWallResetProposal | null> => {
      if (!input) return null;
      const response = await getHttpClient().request<ProposeResponse>(PROPOSE_SPRAY_WALL_RESET, { input });
      return response.proposeSprayWallReset;
    },
    enabled: input != null,
    // The proposal is a pure function of a draft that cannot change under it —
    // a draft carries one photo for its whole life — so there is nothing to
    // refetch for while the screen is open.
    staleTime: Infinity,
    retry: false,
  });
}

/**
 * Land the reviewed reset.
 *
 * `invalidateSprayWallRenderData` is not optional bookkeeping. The SW-07 registry
 * keys every spray cache — the render-data memo, the hold-target memo, the board
 * key, the create-climb screen key — on the wall's version token, and this device
 * is the one that just moved it. Until it re-registers, every one of those keys
 * still names the generation the climber was looking at before they pressed
 * Confirm.
 */
export function useCommitSprayWallVersion(layoutId: number) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: CommitSprayWallVersionInput): Promise<SprayWallResetResult> => {
      const response = await getHttpClient().request<CommitResponse>(COMMIT_SPRAY_WALL_VERSION, { input });
      return response.commitSprayWallVersion;
    },
    retry: false,
    onSuccess: async (_result, input) => {
      await invalidateSprayWallRenderData(queryClient, input.wallUuid, layoutId);
      // Every climb on this wall may have a different integrity number now, and
      // the badge and the filter both read it off the search payload.
      await queryClient.invalidateQueries({ queryKey: ['searchClimbs'] });
      await queryClient.invalidateQueries({ queryKey: mySprayWallsQueryKey });
    },
  });
}

export const remixSeedQueryKey = (parentUuid: string | null) => ['remixClimb', parentUuid] as const;

/**
 * The parent climb with its lost holds stripped out, and what replaced them.
 *
 * `sprayWallUuid` carries the share-link capability: a crew holding an unlisted
 * wall's link may set climbs on it, so they may remix one too. Send it whenever
 * the viewer reached the wall by uuid rather than by owning it; it is ignored
 * when the caller is already a principal.
 */
export function useRemixSeed(parentUuid: string | null, sprayWallUuid?: string | null, enabled = true) {
  return useQuery({
    queryKey: remixSeedQueryKey(parentUuid),
    queryFn: async (): Promise<SprayRemixSeed | null> => {
      if (!parentUuid) return null;
      const response = await getHttpClient().request<RemixResponse>(REMIX_CLIMB, {
        parentUuid,
        sprayWallUuid: sprayWallUuid ?? null,
      });
      return response.remixClimb;
    },
    enabled: enabled && parentUuid != null,
    retry: false,
  });
}

export const sprayWallWithVersionsQueryKey = (wallUuid: string | null) => ['sprayWallWithVersions', wallUuid] as const;

/**
 * The wall and its whole version history.
 *
 * The reset flow needs the history for one reason: a wall carries ONE open draft
 * at a time, and "New photo" on a wall that already has one is not a second
 * reset, it is the same reset the owner walked away from. Asking for the
 * versions is how the screen finds out before it uploads a photograph that would
 * be refused.
 */
export function useSprayWallWithVersions(wallUuid: string | null) {
  return useQuery({
    queryKey: sprayWallWithVersionsQueryKey(wallUuid),
    queryFn: async (): Promise<SprayWall | null> => {
      if (!wallUuid) return null;
      const response = await getHttpClient().request<WallWithVersionsResponse>(GET_SPRAY_WALL_WITH_VERSIONS, {
        uuid: wallUuid,
      });
      return response.sprayWall;
    },
    enabled: wallUuid != null,
  });
}

/**
 * Abandon the open draft, and keep the wall.
 *
 * Not `useDiscardSprayWallDraft` (SW-09), which discards the draft AND deletes
 * the wall: that is the right ending for an add-a-wall attempt nobody finished,
 * and the wrong one here by a mile. A reset's wall is published, carries climbs
 * and is somebody's board — the only thing being thrown away is the photograph.
 *
 * `discardSprayWallVersion` DELETES the row rather than marking it — there is no
 * status that would work, because `superseded` reads as landed and a discarded
 * draft's removals would then take effect. So this is the only way back to a
 * clean wall, and it is the action offered when a reset cannot be resumed.
 */
export function useDiscardSprayWallVersion(wallUuid: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (versionId: string): Promise<boolean> => {
      const response = await getHttpClient().request<DiscardResponse>(DISCARD_SPRAY_WALL_VERSION, {
        input: { versionId },
      });
      return response.discardSprayWallVersion;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: sprayWallWithVersionsQueryKey(wallUuid) }),
  });
}
