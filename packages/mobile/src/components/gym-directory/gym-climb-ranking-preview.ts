import {
  captureGymRankingEnvironment,
  isGymRankingEnvironmentCurrent,
  subscribeGymRankingEnvironment,
} from '@boardsesh/board-react';
import { convertLitUpHoldsStringToMap, toFlatFrames } from '@boardsesh/board-constants/hold-states';
import { GET_CLIMB, GET_SPRAY_CLIMB, GET_SPRAY_WALL_BY_LAYOUT, GET_SPRAY_WALL_RENDER_DATA } from '@boardsesh/graphql';
import type { SprayWall, SprayWallRenderData } from '@boardsesh/graphql/generated/graphql';
import type { Climb, GymClimbRankingTarget } from '@boardsesh/shared-schema';
import { isAuthCredentialGenerationCurrent, subscribeAuthCredentialGenerationChanges } from '../../lib/auth-store';
import { getGymRankingRetirementGeneration, subscribeToGymRankingRetirements } from '../../lib/privacy/privacy-cache';
import { getHttpClient } from '../../lib/graphql/client';
import { requestForGymViewer } from '../../lib/graphql/hooks/use-gym-reporting';
import { mapCanonicalHoldsToPhoto } from '../../lib/spray/spray-hold-geometry';
import { photoDimensions, toCanonicalHolds } from '../../lib/spray/spray-wall-loader';
import type { RankedSprayArt } from '../play-drawer/play-drawer-types';

async function readRankedSprayWall(viewerId: string, target: GymClimbRankingTarget, signal: AbortSignal) {
  const { sprayWallByLayout: wall } = await requestForGymViewer(viewerId, () =>
    getHttpClient().request<{ sprayWallByLayout: SprayWall | null }>({
      document: GET_SPRAY_WALL_BY_LAYOUT,
      variables: { layoutId: target.layoutId },
      signal,
    }),
  );
  if (
    !wall?.currentVersion ||
    wall.hiddenAt ||
    wall.uuid !== target.logicalBoardUuid ||
    wall.board.angle !== target.angle
  )
    throw new Error('Ranking wall is unavailable');
  return { uuid: wall.uuid, version: wall.currentVersion.number };
}

async function readRankedSprayArt(
  viewerId: string,
  target: GymClimbRankingTarget,
  wall: Awaited<ReturnType<typeof readRankedSprayWall>>,
  frames: string,
  signal: AbortSignal,
): Promise<RankedSprayArt> {
  const { sprayWallRenderData: render } = await requestForGymViewer(viewerId, () =>
    getHttpClient().request<{ sprayWallRenderData: SprayWallRenderData | null }>({
      document: GET_SPRAY_WALL_RENDER_DATA,
      variables: { uuid: wall.uuid, version: wall.version },
      signal,
    }),
  );
  if (
    !render ||
    render.wall.hiddenAt ||
    render.wall.board.angle !== target.angle ||
    render.wall.uuid !== wall.uuid ||
    render.wall.currentVersion?.number !== render.versionNumber ||
    render.versionNumber !== wall.version
  )
    throw new Error('Ranking wall is unavailable');

  const dimensions = photoDimensions(render);
  const holds = mapCanonicalHoldsToPhoto(render.homography, toCanonicalHolds(render));
  if (!dimensions || !holds || !render.photo.url) throw new Error('Ranking wall is unavailable');

  const lit = convertLitUpHoldsStringToMap(toFlatFrames(frames, 'spray'), 'spray')[0] ?? {};
  return {
    ...dimensions,
    uri: render.photo.url,
    holds: holds
      .filter(({ id }) => lit[id])
      .map(({ id, cx, cy, r, outline }) => ({
        id,
        cx,
        cy,
        r,
        outline,
        color: lit[id].displayColor || lit[id].color,
      })),
  };
}

export async function readGymClimbPreview(viewerId: string, target: GymClimbRankingTarget, signal: AbortSignal) {
  const config = {
    boardName: target.boardType,
    layoutId: target.layoutId,
    sizeId: target.sizeId,
    setIds: target.setIds,
    angle: target.angle,
  };
  // Pin the wall version before reading frames: publication can remap their hold IDs.
  const wall = config.boardName === 'spray' ? await readRankedSprayWall(viewerId, target, signal) : null;
  const { climb } = await requestForGymViewer(viewerId, () =>
    getHttpClient().request<{ climb: Climb | null }>({
      document: config.boardName === 'spray' ? GET_SPRAY_CLIMB : GET_CLIMB,
      variables: { ...config, climbUuid: target.climbUuid },
      signal,
    }),
  );
  if (!climb?.frames || climb.uuid !== target.climbUuid || climb.angle !== config.angle || climb.is_draft) {
    throw new Error('Ranking climb is unavailable');
  }
  const sprayArt = wall ? await readRankedSprayArt(viewerId, target, wall, climb.frames, signal) : undefined;
  return {
    config,
    climb: { ...climb, mirrored: target.isMirror },
    referenceDifficulty: target.referenceDifficulty,
    sprayArt,
  };
}

export type GymClimbPreviewAuthorization = ReturnType<typeof createGymClimbPreviewAuthorization>;

/** The player owns this receipt after the list deliberately loses route focus. */
export function createGymClimbPreviewAuthorization(expiresAt: number, credentialEpoch: number) {
  const accessGeneration = getGymRankingRetirementGeneration();
  const connectionEpoch = captureGymRankingEnvironment();
  let retired = false;
  const listeners = new Set<() => void>();
  function retire() {
    if (retired) return;
    retired = true;
    clearTimeout(timer);
    unsubscribeEnvironment();
    unsubscribeCredentials();
    unsubscribeAccess();
    for (const listener of listeners) listener();
  }
  function isCurrent() {
    return (
      !retired &&
      accessGeneration === getGymRankingRetirementGeneration() &&
      Date.now() < expiresAt &&
      isGymRankingEnvironmentCurrent(connectionEpoch) &&
      isAuthCredentialGenerationCurrent(credentialEpoch)
    );
  }
  const timer = setTimeout(retire, Math.max(0, expiresAt - Date.now()));
  const unsubscribeEnvironment = subscribeGymRankingEnvironment(() => {
    if (!isCurrent()) retire();
  });
  const unsubscribeCredentials = subscribeAuthCredentialGenerationChanges(retire);
  const unsubscribeAccess = subscribeToGymRankingRetirements(retire);

  function subscribe(listener: () => void) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }
  if (!isCurrent()) retire();
  return { retire, isCurrent, subscribe };
}
