import { Image } from 'react-native';
import { canReadPrivateCatalog, captureCatalogReadEpoch, isCatalogReadCurrent } from '../../offline/catalog-access';
import { getDatabaseHandle } from '../../db';
import { getSprayWallLocal } from '../../db/queries/get-spray-wall-local';
import { readLocalUserId } from '../local-user-id';
import { mapCanonicalHoldsToPhoto } from './spray-hold-geometry';
import { tryGetStoredSprayPhotoPathSync } from './spray-photo-store';
import {
  LIVE_SPRAY_WALL_ARCHIVE_STATE,
  getSprayWall,
  registerSprayWall,
  sprayWallRemovalGeneration,
  sprayWallViewerGeneration,
  type RegisteredSprayArt,
} from './spray-wall-registry';
import { getRememberedSprayWallArchive } from '../../settings/offline-boards';
import { tryGetSprayPhotoPathSync } from './spray-photo-cache';
import type { SprayVersionIdentity } from './spray-photo-keys';

function storedPhotoDimensions(path: string): Promise<{ width: number; height: number } | null> {
  return new Promise((resolve) => {
    Image.getSize(
      `file://${path}`,
      (width, height) =>
        resolve(
          Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0 ? { width, height } : null,
        ),
      () => resolve(null),
    );
  });
}

/**
 * The generated look this wall already draws, when it is for the same
 * published version and its file is still on disk. A revalidation that fails
 * on the network lands here; without this every surface would flip from the
 * art back to the photo for as long as the gym has no signal.
 */
function heldArtFor(layoutId: number, wallUuid: string, version: number): RegisteredSprayArt | null {
  const previous = getSprayWall(layoutId);
  const art = previous?.wallUuid === wallUuid ? previous.art : null;
  if (!art || art.version !== version) return null;
  return tryGetSprayPhotoPathSync({ layoutId, versionId: art.versionId, variant: art.variant }) ? art : null;
}

/** Read only a mirrored published wall, never a wizard or editor draft. */
export async function loadLocalSprayWall(
  layoutId: number,
  viewerGeneration: number,
  removalGeneration: number,
): Promise<boolean> {
  const catalogEpoch = captureCatalogReadEpoch();
  const stillCurrent = () =>
    isCatalogReadCurrent(catalogEpoch) &&
    sprayWallViewerGeneration() === viewerGeneration &&
    sprayWallRemovalGeneration(layoutId) === removalGeneration;
  try {
    const db = getDatabaseHandle();
    if (!db || !stillCurrent() || !(await canReadPrivateCatalog(db)) || !stillCurrent()) return false;
    const userId = await readLocalUserId();
    if (!userId || !stillCurrent()) return false;
    const wall = await getSprayWallLocal(db, layoutId, userId);
    if (!wall || wall.version == null || !Number.isSafeInteger(wall.version) || wall.version < 1 || !wall.homography)
      return false;
    // Server-generated keys bind the photo to this wall and supply immutable
    // identity. A published number never repeats, including same-photo hold edits.
    const photoMatch =
      /^spray-walls\/([^/]+)\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jpg$/i.exec(
        wall.photoKey ?? '',
      );
    if (!photoMatch || photoMatch[1] !== wall.boardUuid) return false;
    const photoPath = tryGetStoredSprayPhotoPathSync(wall.photoKey);
    if (!photoPath) return false;
    const dimensions = await storedPhotoDimensions(photoPath);
    const holds = mapCanonicalHoldsToPhoto(wall.homography, wall.holds);
    if (!dimensions || !holds || !stillCurrent()) return false;
    // Decoder I/O can outlive sign-out or a local wipe. Verify the owner stamp
    // again and refuse a replaced mirror before publishing any private bytes.
    if ((await readLocalUserId()) !== userId || !stillCurrent()) return false;
    const verified = await getSprayWallLocal(db, layoutId, userId);
    if (!verified || verified.photoKey !== wall.photoKey || verified.version !== wall.version || !stillCurrent())
      return false;
    if (!(await canReadPrivateCatalog(db)) || !stillCurrent()) return false;
    const versionId: SprayVersionIdentity = `local-${photoMatch[2]}-${wall.version}`;
    // The mirror has no archive columns: what the server last said is kept
    // beside the offline boards (`rememberSprayWallArchive`), so an archived wall
    // still refuses new climbs offline. Nothing remembered keeps what this session
    // already knew about the wall, or reads it as live.
    const remembered = getRememberedSprayWallArchive(wall.boardUuid);
    registerSprayWall(layoutId, {
      art: heldArtFor(layoutId, wall.boardUuid, wall.version),
      wallUuid: wall.boardUuid,
      angle: null,
      version: wall.version,
      versionId,
      photoWidth: dimensions.width,
      photoHeight: dimensions.height,
      localPhotoPath: photoPath,
      photoUrl: `file://${photoPath}`,
      photoThumbUrl: null,
      photoExpiresAt: '1970-01-01T00:00:00.000Z',
      holds,
      homography: wall.homography,
      viewerAccess: { canEdit: false, generation: viewerGeneration },
      archive: remembered
        ? {
            ...LIVE_SPRAY_WALL_ARCHIVE_STATE,
            archivedAt: remembered.archivedAt,
            replacedByWallUuid: remembered.replacedByWallUuid,
          }
        : undefined,
    });
    return true;
  } catch {
    return false;
  }
}
