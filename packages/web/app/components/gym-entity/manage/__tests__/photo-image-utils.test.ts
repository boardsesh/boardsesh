import { describe, expect, it } from 'vite-plus/test';
import { GYM_PHOTO_MAX_UPLOAD_BYTES as BACKEND_GYM_PHOTO_MAX_UPLOAD_BYTES } from '@boardsesh/shared-schema';
import enKiosk from '@boardsesh/i18n/locales/en-US/kiosk.json';
import esKiosk from '@boardsesh/i18n/locales/es/kiosk.json';
import frKiosk from '@boardsesh/i18n/locales/fr/kiosk.json';
import deKiosk from '@boardsesh/i18n/locales/de/kiosk.json';
import {
  GYM_PHOTO_ACCEPTED_MIME_TYPES,
  GYM_PHOTO_MAX_DIMENSION,
  GYM_PHOTO_MAX_INPUT_BYTES,
  GYM_PHOTO_MAX_INPUT_MB,
  GYM_PHOTO_MAX_UPLOAD_BYTES,
  GYM_PHOTO_MAX_UPLOAD_MB,
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

  it('exposes the caps in MB for the copy, derived from the byte constants', () => {
    expect(GYM_PHOTO_MAX_INPUT_MB).toBe(GYM_PHOTO_MAX_INPUT_BYTES / (1024 * 1024));
    expect(GYM_PHOTO_MAX_UPLOAD_MB).toBe(GYM_PHOTO_MAX_UPLOAD_BYTES / (1024 * 1024));
  });

  it('never hardcodes a size in the copy — all four catalogs interpolate it', () => {
    // Raising a cap must not leave four catalogs quoting the old figure, so no
    // photo string may contain a literal number followed by MB/Mo.
    for (const catalog of [enKiosk, esKiosk, frKiosk, deKiosk]) {
      const photoCopy = catalog.manage.profile.photo;
      const photoStrings = Object.values(photoCopy) as string[];
      expect(photoStrings.length).toBeGreaterThan(0);
      for (const copy of photoStrings) {
        expect(copy).not.toMatch(/\d+\s*(MB|Mo)\b/i);
      }
      for (const sizedKey of ['tooLarge', 'uploadTooLarge', 'formatsHint'] as const) {
        expect(photoCopy[sizedKey]).toContain('{{maxMb}}');
      }
    }
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
