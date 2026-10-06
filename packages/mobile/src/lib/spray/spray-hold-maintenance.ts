import type { SprayWallVersion } from '@boardsesh/graphql/generated/graphql';
import { sprayDraftPurpose } from './spray-draft-purpose';

type MaintenanceVersion = Pick<SprayWallVersion, 'id' | 'number' | 'status' | 'photo' | 'anchors' | 'homography'>;

export type SprayHoldMaintenanceWall = {
  uuid: string;
  layoutId: number;
  viewerCanEdit: boolean;
  /** Set once a reset replaced the wall. An archived wall's holds never change. */
  archivedAt?: string | null;
  /** The wall has a published climb, so its holds are locked. Changing one means a reset. */
  holdsLocked?: boolean | null;
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

/**
 * Why the hold editor cannot open, or cannot publish.
 *
 * - `archived`: a reset replaced the wall; it is read-only.
 * - `holdsLocked`: the wall has a published climb, so its holds no longer
 *   change. Changing one means resetting the wall.
 * - `leftoverPhotoDraft`: the wall's open draft carries a new photo, left by the
 *   in-place reset that no longer exists.
 *
 * `leftoverVersionId` names an open draft the screen can offer to discard: the
 * new-photo draft of `leftoverPhotoDraft`, or, with `archived` or
 * `holdsLocked`, a draft opened before the wall was locked. Such a draft can
 * never be published, and nothing else on the phone would ever clear it.
 */
export type SprayHoldMaintenanceFailure =
  | 'unavailable'
  | 'nothingPublished'
  | 'draftUnavailable'
  | 'archived'
  | 'holdsLocked'
  | 'leftoverPhotoDraft';

export class SprayHoldMaintenanceError extends Error {
  constructor(
    public readonly reason: SprayHoldMaintenanceFailure,
    public readonly leftoverVersionId: string | null = null,
  ) {
    super(reason);
    this.name = 'SprayHoldMaintenanceError';
  }
}

/**
 * The viewer may edit the wall, and the wall's holds may still change.
 *
 * The lock is checked before anything else is read off the wall, so a locked or
 * archived wall is refused even with a draft already open: a deep link or a
 * stale sheet must not reach an editor whose Publish the server will refuse.
 * The refusal names that draft, so the screen can offer to discard it.
 */
function requireEditableWall(wallUuid: string, wall: SprayHoldMaintenanceWall | null): SprayHoldMaintenanceWall {
  if (!wall || wall.uuid !== wallUuid || !wall.viewerCanEdit) {
    throw new SprayHoldMaintenanceError('unavailable');
  }
  const lockedReason = wall.archivedAt != null ? 'archived' : wall.holdsLocked === true ? 'holdsLocked' : null;
  if (lockedReason) {
    const strandedDraft = wall.versions?.find((version) => version.status === 'DRAFT');
    throw new SprayHoldMaintenanceError(lockedReason, strandedDraft?.id ?? null);
  }
  return wall;
}

function prepareTarget(wall: SprayHoldMaintenanceWall, version: MaintenanceVersion): PreparedSprayHoldDraft {
  if (version.status !== 'DRAFT') throw new SprayHoldMaintenanceError('draftUnavailable');
  if (sprayDraftPurpose(version, wall.currentVersion) === 'reset') {
    throw new SprayHoldMaintenanceError('leftoverPhotoDraft', version.id);
  }
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
  if (sprayDraftPurpose(version, wall.currentVersion) === 'reset') {
    throw new SprayHoldMaintenanceError('leftoverPhotoDraft', version.id);
  }

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
