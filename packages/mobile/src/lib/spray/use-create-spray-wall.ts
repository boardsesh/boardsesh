// The three mutations the add-a-wall flow makes (epic #5346, SW-09).
//
// One hook each rather than one hook for the flow, because the flow retries them
// at different granularities: a failed upload re-sends the photo against the
// wall that already exists, and a failed publish re-publishes the version that
// already exists. Bundling them would make every retry a retry of all three,
// which is how a climber tapping "Try again" three times ends up with three
// walls against a cap of ten.

import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  CREATE_SPRAY_WALL,
  CREATE_SPRAY_WALL_VERSION,
  PUBLISH_SPRAY_WALL_VERSION,
} from '@boardsesh/graphql/operations/spray-walls';
import type {
  CreateSprayWallInput,
  CreateSprayWallVersionInput,
  SprayWall,
  SprayWallVersion,
} from '@boardsesh/graphql/generated/graphql';
import type { UserBoard } from '@boardsesh/shared-schema';
import { getHttpClient } from '../graphql/client';

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
type CreateVersionResponse = { createSprayWallVersion: SprayWallVersion };
type PublishResponse = { publishSprayWallVersion: SprayWallVersion };

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
  return useMutation({
    mutationFn: async (input: CreateSprayWallVersionInput): Promise<SprayWallVersion> => {
      const response = await getHttpClient().request<CreateVersionResponse>(CREATE_SPRAY_WALL_VERSION, { input });
      return response.createSprayWallVersion;
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
