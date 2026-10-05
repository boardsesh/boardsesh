// The three mutations the add-a-wall flow makes (epic #5346, SW-09).
//
// One hook each rather than one hook for the flow, because the flow retries them
// at different granularities: a failed upload re-sends the photo against the
// wall that already exists, and a failed publish re-publishes the version that
// already exists. Bundling them would make every retry a retry of all three,
// which is how a climber tapping "Try again" three times ends up with three
// walls against a cap of ten.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CREATE_SPRAY_WALL,
  CREATE_SPRAY_WALL_VERSION,
  DELETE_SPRAY_WALL,
  DISCARD_SPRAY_WALL_VERSION,
  GET_MY_SPRAY_WALLS,
  GET_SPRAY_WALL_WITH_VERSIONS,
  PUBLISH_SPRAY_WALL_VERSION,
  SET_SPRAY_WALL_RENDER_SETTINGS,
  UPDATE_SPRAY_WALL,
} from '@boardsesh/graphql/operations/spray-walls';
import type {
  CreateSprayWallInput,
  CreateSprayWallVersionInput,
  SprayWall,
  SprayWallVersion,
} from '@boardsesh/graphql/generated/graphql';
import type { UserBoard } from '@boardsesh/shared-schema';
import { getHttpClient } from '../graphql/client';
import type { BoardRenderDefault } from '../board-render-settings';
import { primeSprayWallLook } from './spray-wall-loader';
import { listRegisteredSprayWalls, unregisterSprayWall } from './spray-wall-registry';
import { sprayWallWithVersionsQueryKey } from './use-spray-wall-reset';

/** The owner's wall list, invalidated the moment a wall becomes one. */
export const mySprayWallsQueryKey = ['mySprayWalls'] as const;

/**
 * The wall, with its board row typed the way the rest of the app types a board.
 *
 * codegen gives `SprayWall.board` the generated `UserBoard`, whose nullable
 * fields are `Maybe<T>` where the hand-written `UserBoard` every board surface
 * takes uses `T | undefined`. The wire values are the same; the two declarations
 * are not assignable. Narrowing here — exactly as `CreateBoardMutationResponse`
 * does for `createBoard` — keeps the cast out of the screen, which needs a real
 * `UserBoard` to hand to `useActivateBoard`.
 */
export type CreatedSprayWall = Omit<SprayWall, 'board'> & { board: UserBoard };

type CreateWallResponse = { createSprayWall: CreatedSprayWall };
type MySprayWallsResponse = { mySprayWalls: SprayWall[] };
type SprayWallWithVersionsResponse = { sprayWall: CreatedSprayWall | null };
type CreateVersionResponse = { createSprayWallVersion: SprayWallVersion };
type PublishResponse = { publishSprayWallVersion: SprayWallVersion };
type UpdateWallResponse = { updateSprayWall: CreatedSprayWall };
type SetRenderSettingsResult = Pick<SprayWall, 'uuid' | 'renderSettings'>;
type SetRenderSettingsResponse = { setSprayWallRenderSettings: SetRenderSettingsResult };

/**
 * Create the wall row, its catalogue layout and its size.
 *
 * Called once per flow, BEFORE the photo is uploaded, because the upload handler
 * authorises against the wall it is for — a photograph of somebody's home is
 * never accepted without one. The wall that comes back has no version yet, so it
 * is not drawable and is not in anybody's board list until the first version
 * publishes.
 */
export function useCreateSprayWall() {
  return useMutation({
    mutationFn: async (input: CreateSprayWallInput): Promise<CreatedSprayWall> => {
      const response = await getHttpClient().request<CreateWallResponse>(CREATE_SPRAY_WALL, { input });
      return response.createSprayWall;
    },
  });
}

/**
 * Adopt an uploaded photo as the wall's draft version.
 *
 * Refused while another draft is open (`docs/spray-walls.md`, "One open draft
 * per wall"), which is exactly what a climber who abandoned a flow yesterday
 * will hit today — so the screen shows the server's own message rather than a
 * generic failure: it names the draft that is in the way.
 */
export function useCreateSprayWallVersion() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateSprayWallVersionInput): Promise<SprayWallVersion> => {
      const response = await getHttpClient().request<CreateVersionResponse>(CREATE_SPRAY_WALL_VERSION, { input });
      return response.createSprayWallVersion;
    },
    onSuccess: (_version, input) =>
      queryClient.invalidateQueries({
        queryKey: sprayWallWithVersionsQueryKey(input.wallUuid),
      }),
  });
}

/**
 * The caller's own walls, asked for once when the add-a-wall flow opens.
 *
 * Its whole job is finding an unfinished wall to offer back (`resume-draft.ts`).
 * `staleTime: 0` on purpose: a wall abandoned five minutes ago on this very
 * device must be found, and a cached list from before that is exactly what would
 * hide it and let the flow mint a second wall beside the first.
 */
export function useMySprayWalls(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: mySprayWallsQueryKey,
    queryFn: async (): Promise<SprayWall[]> => {
      const response = await getHttpClient().request<MySprayWallsResponse>(GET_MY_SPRAY_WALLS);
      return response.mySprayWalls;
    },
    enabled: options?.enabled ?? true,
    staleTime: 0,
  });
}

/** One wall WITH its version history — the only query that can see an open draft. */
export async function fetchSprayWallVersions(uuid: string): Promise<CreatedSprayWall | null> {
  const response = await getHttpClient().request<SprayWallWithVersionsResponse>(GET_SPRAY_WALL_WITH_VERSIONS, {
    uuid,
  });
  return response.sprayWall;
}

/**
 * Throw away an abandoned attempt: discard its open draft, then delete the wall.
 *
 * Order matters and is stated in `startOverPlan`. Both calls are best-effort at
 * the call site — a start-over that cannot reach the server must still let the
 * climber build their wall — so this hook reports rather than blocks, and a
 * stray row is left for the SW-17 cleanup job.
 */
export function useDiscardSprayWallDraft() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ versionId, wallUuid }: { versionId: string | null; wallUuid: string }): Promise<void> => {
      const client = getHttpClient();
      if (versionId) await client.request(DISCARD_SPRAY_WALL_VERSION, { input: { versionId } });
      await client.request(DELETE_SPRAY_WALL, { uuid: wallUuid });
    },
    onSuccess: async (_result, { wallUuid }) => {
      // Initial drafts stay registered between editor and look steps. Explicit
      // Start over deletes that wall, so withdraw its geometry at this boundary.
      for (const wall of listRegisteredSprayWalls()) {
        if (wall.wallUuid === wallUuid) unregisterSprayWall(wall.layoutId);
      }
      await queryClient.cancelQueries({ queryKey: ['sprayWallRenderData', wallUuid] });
      queryClient.removeQueries({ queryKey: ['sprayWallRenderData', wallUuid] });
      await queryClient.invalidateQueries({ queryKey: mySprayWallsQueryKey });
    },
  });
}

/**
 * Share a wall that was created private.
 *
 * Every wall is created private whatever the climber chose, because
 * `searchBoards` filters on `is_public` / `is_unlisted` alone and would list a
 * wall with no version, no photo and no holds as a board other people could try
 * to climb on. This is the second half: run it once the first version publishes,
 * which is the first moment there is anything to see. Idempotent, so a retry
 * after a failed board bind may run it again.
 */
export function useUpdateSprayWallVisibility() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { uuid: string; isPublic: boolean; isUnlisted: boolean }): Promise<CreatedSprayWall> => {
      const response = await getHttpClient().request<UpdateWallResponse>(UPDATE_SPRAY_WALL, { input });
      return response.updateSprayWall;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: mySprayWallsQueryKey });
    },
  });
}

/**
 * Publish the draft: the wall's holds become the generation climbers see, and
 * the wall becomes a board that can be browsed, queued and climbed on.
 *
 * Invalidates `mySprayWalls` so the wall list the owner comes back to includes
 * it without waiting for a refetch window.
 */
export function usePublishSprayWallVersion() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (versionId: string): Promise<SprayWallVersion> => {
      const response = await getHttpClient().request<PublishResponse>(PUBLISH_SPRAY_WALL_VERSION, {
        input: { versionId },
      });
      return response.publishSprayWallVersion;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: mySprayWallsQueryKey });
    },
  });
}

/**
 * Store the wall's default look — the one a climber who never picked a render
 * mode sees on it. The add-a-wall flow's look step writes it once, before the
 * publish, so the wall's first climbers already get it.
 *
 * Idempotent (the last write wins), so a retry after a lost response is safe.
 * On success the look goes straight into the look cache and the registry, so the
 * wall draws it now rather than after the cache's window runs out.
 */
export function useSetSprayWallRenderSettings() {
  return useMutation({
    mutationFn: async ({
      uuid,
      renderSettings,
    }: {
      layoutId: number;
      uuid: string;
      renderSettings: BoardRenderDefault;
    }): Promise<SetRenderSettingsResult> => {
      const response = await getHttpClient().request<SetRenderSettingsResponse>(SET_SPRAY_WALL_RENDER_SETTINGS, {
        input: { uuid, renderSettings },
      });
      return response.setSprayWallRenderSettings;
    },
    onSuccess: (_result, { layoutId, uuid, renderSettings }) => {
      primeSprayWallLook(layoutId, uuid, renderSettings);
    },
  });
}
