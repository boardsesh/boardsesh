import type { IncomingMessage, ServerResponse } from 'http';
import { deleteGymLogosFromS3 } from '../storage/s3';
import { buildStaticGymLogoUrl } from '../lib/gym-logo-url';
import { createGymImageUploadHandler } from './gym-image-upload';

// Gym logo upload configuration. Deliberately mirrors avatars.ts: 2MB cap, the
// same raster mime allowlist (NO svg — an inline <svg> logo would execute
// script when rendered on the kiosk/embed surfaces), S3 or local-dev storage.
// The upload mechanics themselves live in gym-image-upload.ts, shared with the
// public-page gym photo (gym-photos.ts).
const GYM_LOGOS_DIR = './gym-logos';
const MAX_FILE_SIZE = 2 * 1024 * 1024; // 2MB

const uploadHandler = createGymImageUploadHandler({
  fileFieldName: 'logo',
  storagePrefix: 'gym-logos',
  localDir: GYM_LOGOS_DIR,
  maxFileSizeBytes: MAX_FILE_SIZE,
  responseUrlKey: 'logoUrl',
  buildStaticUrl: buildStaticGymLogoUrl,
  // Called through, not captured: binding the import here would freeze the
  // module-init reference and make a later vi.spyOn on the storage module a
  // no-op for this handler.
  deleteStaleObjectsFromS3: (gymUuid, keepExt) => deleteGymLogosFromS3(gymUuid, keepExt),
  messages: {
    notConfigured: 'Gym logo uploads are not configured. Please contact the administrator.',
    saveFailed: 'Failed to save gym logo',
    authorizeFailed: 'Failed to authorize gym logo upload',
  },
  logLabel: 'gym logo',
});

/**
 * Gym logo upload handler
 * POST /api/gym-logos
 *
 * Expects multipart form data with:
 * - logo: the image file
 * - gymUuid: the gym UUID (UUID format)
 *
 * Requires authentication via Authorization header (Bearer token). The caller
 * must have edit access to the gym (owner, gym admin/editor, or a covering
 * community admin/leader), enforced by userCanEditGym.
 */
export function handleGymLogoUpload(req: IncomingMessage, res: ServerResponse): Promise<void> {
  return uploadHandler(req, res);
}

/**
 * Get the gym-logos directory path (for static file serving).
 */
export function getGymLogosDir(): string {
  return GYM_LOGOS_DIR;
}
