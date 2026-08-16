import { describe, expect, it } from 'vite-plus/test';
import { GYM_PHOTO_MAX_UPLOAD_BYTES as BACKEND_GYM_PHOTO_MAX_UPLOAD_BYTES } from '@boardsesh/shared-schema';
import {
  GYM_PHOTO_ACCEPTED_MIME_TYPES,
  GYM_PHOTO_MAX_DIMENSION,
  GYM_PHOTO_MAX_INPUT_BYTES,
  GYM_PHOTO_MAX_UPLOAD_BYTES,
  resolvePhotoEncodingPlan,
  scaleToFit,
} from '../photo-image-utils';

describe('resolvePhotoEncodingPlan', () => {
  it('re-encodes every accepted type as JPEG over a white ground', () => {
    for (const mimeType of GYM_PHOTO_ACCEPTED_MIME_TYPES) {
      const plan = resolvePhotoEncodingPlan(mimeType);
      expect(plan).not.toBeNull();
      expect(plan!.outputMimeType).toBe('image/jpeg');
      expect(plan!.fillWhite).toBe(true);
      expect(plan!.quality).toBeGreaterThan(0);
      expect(plan!.quality).toBeLessThanOrEqual(1);
    }
  });

  it('returns null for unsupported types', () => {
    // GIF is allowed for logos (animated brand marks) but not for a wall shot;
    // SVG is refused everywhere — it would carry script onto the public page.
    for (const mimeType of ['image/gif', 'image/svg+xml', 'application/pdf', 'text/html', '']) {
      expect(resolvePhotoEncodingPlan(mimeType)).toBeNull();
    }
  });
});

describe('gym photo size caps', () => {
  it('uses the backend constant verbatim for the upload cap', () => {
    // If these ever diverge, an owner either waits through an upload the server
    // then rejects, or is refused a photo the server would have taken.
    expect(GYM_PHOTO_MAX_UPLOAD_BYTES).toBe(BACKEND_GYM_PHOTO_MAX_UPLOAD_BYTES);
  });

  it('lets the picker accept a bigger file than it uploads, because it downscales first', () => {
    expect(GYM_PHOTO_MAX_INPUT_BYTES).toBeGreaterThan(GYM_PHOTO_MAX_UPLOAD_BYTES);
  });
});

describe('scaleToFit at the photo ceiling', () => {
  it('caps the longest side and keeps the aspect ratio', () => {
    expect(scaleToFit(4032, 3024, GYM_PHOTO_MAX_DIMENSION)).toEqual({ width: 1920, height: 1440 });
    expect(scaleToFit(3024, 4032, GYM_PHOTO_MAX_DIMENSION)).toEqual({ width: 1440, height: 1920 });
  });

  it('never upscales a small photo', () => {
    expect(scaleToFit(800, 600, GYM_PHOTO_MAX_DIMENSION)).toEqual({ width: 800, height: 600 });
  });
});
