import type { IncomingMessage, ServerResponse } from 'http';
import { eq, and, isNull } from 'drizzle-orm';
import * as dbSchema from '@boardsesh/db/schema';
import { GYM_PHOTO_MAX_UPLOAD_BYTES } from '@boardsesh/shared-schema';
import { applyCorsHeaders } from './cors';
import { validateToken } from '../middleware/auth';
import { db } from '../db/client';
import { userCanEditGym } from '../graphql/resolvers/social/gyms';
import { isS3Configured, deleteGymPhotosFromS3 } from '../storage/s3';
import { logger } from '../utils/logger';
import { buildStaticGymPhotoUrl } from '../lib/gym-photo-url';
import {
  createGymImageUploadHandler,
  deleteExistingLocalImages,
  extractAuthTokenFromHeader,
  validateGymUuid,
  type GymImageUploadConfig,
} from './gym-image-upload';

// Gym photo upload configuration — one shot of the gym's wall or board area,
// stored in gyms.image_url and rendered as the public gym page's hero and its
// share card. Same machinery as the kiosk logo (gym-image-upload.ts), with a
// roomier cap: this is a photograph, not a brand mark, and the console
// downscales before it POSTs.
const GYM_PHOTOS_DIR = './gym-photos';

/** Exported so a test can pin the size cap to the one shared constant. */
export const GYM_PHOTO_UPLOAD_CONFIG: GymImageUploadConfig = {
  fileFieldName: 'photo',
  storagePrefix: 'gym-photos',
  localDir: GYM_PHOTOS_DIR,
  maxFileSizeBytes: GYM_PHOTO_MAX_UPLOAD_BYTES,
  responseUrlKey: 'photoUrl',
  buildStaticUrl: buildStaticGymPhotoUrl,
  // Called through, not captured: binding the import here would freeze the
  // module-init reference and make a later vi.spyOn on the storage module a
  // no-op for this handler.
  deleteStaleObjectsFromS3: (gymUuid, keepExt) => deleteGymPhotosFromS3(gymUuid, keepExt),
  messages: {
    notConfigured: 'Gym photo uploads are not configured. Please contact the administrator.',
    saveFailed: 'Failed to save gym photo',
    authorizeFailed: 'Failed to authorize gym photo upload',
  },
  logLabel: 'gym photo',
};

const uploadHandler = createGymImageUploadHandler(GYM_PHOTO_UPLOAD_CONFIG);

/**
 * Gym photo upload handler
 * POST /api/gym-photos
 *
 * Expects multipart form data with:
 * - photo: the image file
 * - gymUuid: the gym UUID (UUID format)
 *
 * Requires authentication via Authorization header (Bearer token). The caller
 * must have edit access to the gym (owner, gym admin/editor, or a covering
 * community admin/leader), enforced by userCanEditGym.
 */
export function handleGymPhotoUpload(req: IncomingMessage, res: ServerResponse): Promise<void> {
  return uploadHandler(req, res);
}

/**
 * Gym photo delete handler
 * DELETE /api/gym-photos?gymUuid=<uuid>
 *
 * Removes the gym's photo: nulls gyms.image_url FIRST, then drops every stored
 * extension. That order is the whole point — an orphaned object costs a few
 * hundred KB and can be swept later, while a row still pointing at a deleted
 * object is a broken image on the public page.
 *
 * The column clear happens HERE rather than being left to the caller. The
 * manage console does call updateGym first, but a direct API call in the wrong
 * order (or one that never sends the mutation) would otherwise strand exactly
 * the dangling URL this ordering exists to prevent. Nulling an already-null
 * column is a no-op, so the console's belt-and-braces sequence still works.
 */
export async function handleGymPhotoDelete(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!applyCorsHeaders(req, res)) return;

  const token = extractAuthTokenFromHeader(req);
  if (!token) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Authentication required' }));
    return;
  }

  const authResult = await validateToken(token);
  if (!authResult) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid or expired token' }));
    return;
  }

  const requestUrl = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const gymUuid = requestUrl.searchParams.get('gymUuid');
  if (!gymUuid || !validateGymUuid(gymUuid)) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid gymUuid format' }));
    return;
  }

  try {
    const [gym] = await db
      .select()
      .from(dbSchema.gyms)
      .where(and(eq(dbSchema.gyms.uuid, gymUuid), isNull(dbSchema.gyms.deletedAt)))
      .limit(1);

    if (!gym) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Gym not found' }));
      return;
    }

    const canEdit = await userCanEditGym(gym, authResult.userId);
    if (!canEdit) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'You do not have permission to edit this gym' }));
      return;
    }
  } catch (authzErr) {
    logger.error('Failed to authorize gym photo delete:', authzErr);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Failed to authorize gym photo delete' }));
    return;
  }

  // Clear the column before touching storage, and fail the request if it
  // doesn't land — deleting the object while the row still references it is
  // the one outcome worth returning an error for.
  try {
    await db
      .update(dbSchema.gyms)
      .set({ imageUrl: null, updatedAt: new Date() })
      .where(eq(dbSchema.gyms.uuid, gymUuid));
  } catch (clearErr) {
    logger.error('Failed to clear gym photo URL:', clearErr);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Failed to remove gym photo' }));
    return;
  }

  // No keepExt — every extension goes. Best-effort from here: the photo is
  // already gone from every surface, so a storage failure leaves nothing worse
  // than an unreferenced object.
  if (isS3Configured()) {
    await deleteGymPhotosFromS3(gymUuid);
  } else {
    await deleteExistingLocalImages(GYM_PHOTOS_DIR, 'gym photo', gymUuid);
  }

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ success: true }));
}

/**
 * Get the gym-photos directory path (for static file serving).
 */
export function getGymPhotosDir(): string {
  return GYM_PHOTOS_DIR;
}
