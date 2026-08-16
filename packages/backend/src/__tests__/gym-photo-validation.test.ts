import { describe, expect, it } from 'vite-plus/test';
import { GYM_PHOTO_MAX_UPLOAD_BYTES } from '@boardsesh/shared-schema';
import { CreateGymInputSchema, UpdateGymInputSchema } from '../validation/schemas/gyms';

/**
 * Pins the two behaviours that made a bare `z.string().url()` unusable for
 * gyms.image_url. Zod's `.url()` is a format check, not a scheme check: it
 * ACCEPTS `javascript:` and `data:` (both of which reach an `<img src>` and the
 * JSON-LD `image` on the public gym page) and REJECTS the relative
 * `/static/gym-photos/...` path our own uploader returns — so an upload would
 * have stored the object and then 400'd on the follow-up updateGym.
 */

const GYM_UUID = '11111111-2222-4333-8444-555555555555';
const STATIC_PHOTO_PATH = `/static/gym-photos/${GYM_UUID}.jpg`;

describe('gym photo URL validation', () => {
  const hostileUrls = [
    'javascript:alert(1)',
    'JavaScript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'data:image/svg+xml;base64,PHN2Zy8+',
    'vbscript:msgbox(1)',
  ];

  for (const hostileUrl of hostileUrls) {
    it(`rejects ${hostileUrl} on updateGym`, () => {
      const result = UpdateGymInputSchema.safeParse({ gymUuid: GYM_UUID, imageUrl: hostileUrl });
      expect(result.success).toBe(false);
    });

    it(`rejects ${hostileUrl} on createGym`, () => {
      const result = CreateGymInputSchema.safeParse({ name: 'Test Gym', imageUrl: hostileUrl });
      expect(result.success).toBe(false);
    });
  }

  it('accepts the static path POST /api/gym-photos returns, with and without the cache-busting version', () => {
    for (const candidate of [STATIC_PHOTO_PATH, `${STATIC_PHOTO_PATH}?v=abc-123`]) {
      const result = UpdateGymInputSchema.safeParse({ gymUuid: GYM_UUID, imageUrl: candidate });
      expect(result.success).toBe(true);
    }
  });

  it('accepts every extension the uploader can write', () => {
    for (const ext of ['jpg', 'jpeg', 'png', 'gif', 'webp']) {
      const result = UpdateGymInputSchema.safeParse({
        gymUuid: GYM_UUID,
        imageUrl: `/static/gym-photos/${GYM_UUID}.${ext}`,
      });
      expect(result.success).toBe(true);
    }
  });

  it('accepts an https URL and rejects plain http', () => {
    expect(
      UpdateGymInputSchema.safeParse({ gymUuid: GYM_UUID, imageUrl: 'https://cdn.example.com/gym.jpg' }).success,
    ).toBe(true);
    expect(
      UpdateGymInputSchema.safeParse({ gymUuid: GYM_UUID, imageUrl: 'http://cdn.example.com/gym.jpg' }).success,
    ).toBe(false);
  });

  it('rejects a traversal or foreign static path', () => {
    for (const candidate of [
      '/static/gym-photos/../../etc/passwd',
      '/static/gym-logos/' + GYM_UUID + '.jpg',
      '/static/gym-photos/' + GYM_UUID + '.svg',
      `/static/gym-photos/${GYM_UUID}.jpg?v=<script>`,
    ]) {
      expect(UpdateGymInputSchema.safeParse({ gymUuid: GYM_UUID, imageUrl: candidate }).success).toBe(false);
    }
  });

  it('still accepts null to clear the photo', () => {
    expect(UpdateGymInputSchema.safeParse({ gymUuid: GYM_UUID, imageUrl: null }).success).toBe(true);
  });
});

describe('gym photo size cap', () => {
  it('is the single shared constant, not a second copy of the number', async () => {
    // The handler's Busboy limit and the manage console's pre-upload check read
    // the same export, so the client can neither pre-reject a photo the server
    // would accept nor let one through that Busboy will truncate mid-stream.
    const { GYM_PHOTO_UPLOAD_CONFIG } = await import('../handlers/gym-photos');
    expect(GYM_PHOTO_UPLOAD_CONFIG.maxFileSizeBytes).toBe(GYM_PHOTO_MAX_UPLOAD_BYTES);
  });
});
