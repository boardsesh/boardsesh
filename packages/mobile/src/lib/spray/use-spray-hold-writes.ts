// The spray hold editor's one write (issue #5441).
//
// Two mutations behind one hook, because from the editor's side Save is one
// action and a half-applied Save is the failure worth designing against.
//
// Removals go FIRST. A merge takes two holds off the wall and puts one back with
// the union's geometry; if the upsert landed first, the wall would momentarily
// carry both the merged hold and the victim it swallowed, and a failure between
// the two calls would leave that state on the server. Removing first means the
// worst interrupted Save is a wall with holds missing — visible, and fixed by
// drawing them again — rather than a wall with duplicates nobody can tell apart.
//
// Neither mutation is offline-queued. The editing session is a sitting in front
// of the wall with the photo on screen; a write replayed hours later against a
// draft that has since been published or discarded is a write that cannot mean
// what it meant when it was made.

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { REMOVE_SPRAY_WALL_HOLDS, UPSERT_SPRAY_WALL_HOLDS } from '@boardsesh/graphql/operations/spray-walls';
import { getHttpClient } from '../graphql/client';
import type { SprayHoldWritePlan } from '../../components/outline-editor/spray-hold-writes';
import { sprayWallDraftQueryKey } from './use-spray-wall-draft';

export type SaveSprayHoldsVariables = {
  wallUuid: string;
  /** `SprayWallVersion.number` of the draft, so the save can refetch what it wrote. */
  versionNumber: number;
  /** The DRAFT version's id. Published versions are immutable. */
  versionId: string;
  plan: SprayHoldWritePlan;
};

export type SaveSprayHoldsResult = {
  /** How many holds `upsertSprayWallHolds` wrote. */
  written: number;
  /** How many holds `removeSprayWallHolds` took off. */
  removed: number;
};

type UpsertResponse = { upsertSprayWallHolds: { id: number }[] };
type RemoveResponse = { removeSprayWallHolds: number };

/**
 * Apply an editor session's plan to the wall's draft version.
 *
 * On success the wall's render payload is invalidated, which is what walks the
 * new holds back through `useSprayWall` into the SW-07 registry — so the board
 * behind the editor, every queue thumbnail and the play drawer all redraw from
 * one refetch instead of each holding their own copy.
 */
export function useSaveSprayHolds() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ wallUuid, versionId, plan }: SaveSprayHoldsVariables): Promise<SaveSprayHoldsResult> => {
      const client = getHttpClient();
      let removed = 0;
      if (plan.removeIds.length > 0) {
        const response = await client.request<RemoveResponse>(REMOVE_SPRAY_WALL_HOLDS, {
          input: { wallUuid, versionId, holdIds: [...plan.removeIds] },
        });
        removed = response.removeSprayWallHolds;
      }

      let written = 0;
      if (plan.upsert.length > 0) {
        const response = await client.request<UpsertResponse>(UPSERT_SPRAY_WALL_HOLDS, {
          input: { wallUuid, versionId, holds: plan.upsert },
        });
        written = response.upsertSprayWallHolds.length;
      }

      return { written, removed };
    },
    onSuccess: (_result, { wallUuid, versionNumber }) => {
      // The DRAFT's payload, not the published wall's: the editor reads the
      // version it is writing to (`useSprayWallDraft`), and that is the query
      // that now holds stale holds. Invalidating it re-fetches, which
      // re-registers, which is what puts the server's own ids on the holds this
      // session minted locally.
      void queryClient.invalidateQueries({ queryKey: sprayWallDraftQueryKey(wallUuid, versionNumber) });
    },
  });
}
