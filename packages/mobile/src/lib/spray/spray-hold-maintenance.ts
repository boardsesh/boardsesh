import type { SprayWallVersion } from '@boardsesh/graphql/generated/graphql';

type MaintenanceVersion = Pick<SprayWallVersion, 'id' | 'number' | 'status'>;

export type SprayHoldMaintenanceWall = {
  uuid: string;
  layoutId: number;
  viewerCanEdit: boolean;
  currentVersion?: MaintenanceVersion | null;
  versions?: readonly MaintenanceVersion[] | null;
};

export type PreparedSprayHoldDraft = {
  wallUuid: string;
  layoutId: number;
  versionId: string;
  versionNumber: number;
  viewerCanEdit: true;
};

export type SprayHoldMaintenanceTransport = {
  fetchWall: (wallUuid: string) => Promise<SprayHoldMaintenanceWall | null>;
  createDraft: (input: { wallUuid: string; sourceVersionId: string }) => Promise<MaintenanceVersion>;
  publishDraft: (versionId: string) => Promise<MaintenanceVersion>;
};

export class SprayHoldMaintenanceError extends Error {
  constructor(public readonly reason: 'unavailable' | 'nothingPublished' | 'draftUnavailable') {
    super(reason);
    this.name = 'SprayHoldMaintenanceError';
  }
}

function requireEditableWall(wallUuid: string, wall: SprayHoldMaintenanceWall | null): SprayHoldMaintenanceWall {
  if (!wall || wall.uuid !== wallUuid || !wall.viewerCanEdit) {
    throw new SprayHoldMaintenanceError('unavailable');
  }
  return wall;
}

function prepareTarget(wall: SprayHoldMaintenanceWall, version: MaintenanceVersion): PreparedSprayHoldDraft {
  if (version.status !== 'DRAFT') throw new SprayHoldMaintenanceError('draftUnavailable');
  return {
    wallUuid: wall.uuid,
    layoutId: wall.layoutId,
    versionId: version.id,
    versionNumber: version.number,
    viewerCanEdit: true,
  };
}

/** Fresh permissions and a single frozen draft, including a lost create response. */
export async function prepareSprayHoldDraft(
  wallUuid: string,
  transport: SprayHoldMaintenanceTransport,
): Promise<PreparedSprayHoldDraft> {
  const wall = requireEditableWall(wallUuid, await transport.fetchWall(wallUuid));
  const openDraft = wall.versions?.find((version) => version.status === 'DRAFT');
  if (openDraft) return prepareTarget(wall, openDraft);
  if (!wall.currentVersion) throw new SprayHoldMaintenanceError('nothingPublished');

  try {
    const draft = await transport.createDraft({ wallUuid, sourceVersionId: wall.currentVersion.id });
    return prepareTarget(wall, draft);
  } catch (createError) {
    // The other device may have won the wall lock, or our response may have
    // disappeared after the insert committed. Either way there is one draft.
    let latestWallSnapshot: SprayHoldMaintenanceWall | null;
    try {
      latestWallSnapshot = await transport.fetchWall(wallUuid);
    } catch {
      throw createError;
    }
    const latestWall = requireEditableWall(wallUuid, latestWallSnapshot);
    const createdDraft = latestWall.versions?.find((version) => version.status === 'DRAFT');
    if (createdDraft) return prepareTarget(latestWall, createdDraft);
    throw createError;
  }
}

function findPreparedVersion(wall: SprayHoldMaintenanceWall, draft: PreparedSprayHoldDraft): MaintenanceVersion {
  const version = wall.versions?.find((candidate) => candidate.id === draft.versionId);
  if (!version || version.number !== draft.versionNumber || wall.layoutId !== draft.layoutId) {
    throw new SprayHoldMaintenanceError('draftUnavailable');
  }
  return version;
}

/** Never retry a publish that already landed, including one later superseded. */
export async function publishSprayHoldDraft(
  draft: PreparedSprayHoldDraft,
  transport: SprayHoldMaintenanceTransport,
): Promise<void> {
  const wall = requireEditableWall(draft.wallUuid, await transport.fetchWall(draft.wallUuid));
  const version = findPreparedVersion(wall, draft);
  if (version.status !== 'DRAFT') return;

  try {
    await transport.publishDraft(draft.versionId);
  } catch (publishError) {
    let latestWallSnapshot: SprayHoldMaintenanceWall | null;
    try {
      latestWallSnapshot = await transport.fetchWall(draft.wallUuid);
    } catch {
      // Recovery is best effort; keep the failure from the requested write.
      throw publishError;
    }
    // A successful recovery read can reveal revoked access. Report that current
    // access failure even if publication landed; future retries must stay gated.
    const latestWall = requireEditableWall(draft.wallUuid, latestWallSnapshot);
    const latestVersion = findPreparedVersion(latestWall, draft);
    if (latestVersion.status !== 'DRAFT') return;
    throw publishError;
  }
}
