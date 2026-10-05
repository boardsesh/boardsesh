import { listOverlayCacheEntries } from '../../hooks/overlay-cache-warmup';
import { forgetSprayOverlays } from '../overlay-index';
import { deleteCachedSprayPhotos } from './spray-photo-cache';
import { unregisterSprayWall, withdrawAllSprayWalls, setSprayWallPrivacyCleanup } from './spray-wall-registry';
import { sprayOverlayLayoutId } from './spray-privacy-generation';

/** Withdraw first, so suspended native writes cannot repopulate these caches. */
function erasePrivateCaches(layoutId?: number): void {
  deleteCachedSprayPhotos(layoutId);
  forgetSprayOverlays(layoutId);
  try {
    for (const entry of listOverlayCacheEntries('board-thumbnails') ?? []) {
      const wallId = sprayOverlayLayoutId(entry.name ?? '');
      if (wallId !== null && (layoutId == null || wallId === layoutId)) {
        try {
          entry.delete?.();
        } catch {
          /* Continue cleaning other entries. */
        }
      }
    }
  } catch {
    /* Filesystem failure must not prevent sign-out. */
  }
}

// A loader that discovers deletion/visibility withdrawal must erase its files
// too. The registry owns withdrawal; this platform module supplies its I/O.
setSprayWallPrivacyCleanup(erasePrivateCaches);

export function clearSprayWallPrivateCaches(layoutId?: number): void {
  if (layoutId == null) withdrawAllSprayWalls();
  else unregisterSprayWall(layoutId);
}
