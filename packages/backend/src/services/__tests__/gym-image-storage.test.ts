import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { ALLOWED_IMAGE_SIZES } from '@boardsesh/shared-schema';

const storage = vi.hoisted(() => ({ remove: vi.fn(), mediaBase: null as string | null }));
vi.mock('../../storage/s3', () => ({
  isS3Configured: () => true,
  deleteFromS3: storage.remove,
  uploadToS3: vi.fn(),
  getMediaPublicBaseUrl: () => storage.mediaBase,
}));

import { managedGymImageKey, removeManagedGymImage, removeVersionedGymImage } from '../gym-image-storage';

const gymUuid = '11111111-1111-4111-8111-111111111111';
const otherGymUuid = '22222222-2222-4222-8222-222222222222';

describe('gym image removal', () => {
  beforeEach(() => {
    storage.remove.mockReset().mockResolvedValue(undefined);
    storage.mediaBase = null;
  });

  it.each(['photo', 'logo'] as const)('clears a web-uploaded %s and its public resize variants', async (kind) => {
    const prefix = kind === 'photo' ? 'gym-photos' : 'gym-logos';
    const key = `${prefix}/${gymUuid}.jpg`;
    await removeManagedGymImage(gymUuid, kind, `/static/${key}?v=web-upload`);
    expect(storage.remove).toHaveBeenCalledWith('media', key);
    for (const size of ALLOWED_IMAGE_SIZES) {
      expect(storage.remove).toHaveBeenCalledWith('media', `${key}@${size}.jpg`);
    }
    expect(storage.remove).toHaveBeenCalledTimes(1 + ALLOWED_IMAGE_SIZES.length);
  });

  it('keeps a mutable upload when replacing its URL with a new cache version', async () => {
    await removeVersionedGymImage(gymUuid, 'photo', `/static/gym-photos/${gymUuid}.jpg?v=old`);
    expect(storage.remove).not.toHaveBeenCalled();
  });

  it.each(['photo', 'logo'] as const)(
    'identifies legacy and versioned %s objects independently of cache versions',
    (kind) => {
      const prefix = kind === 'photo' ? 'gym-photos' : 'gym-logos';
      for (const fileName of [`${gymUuid}.jpg`, `${gymUuid}.${otherGymUuid}.png`]) {
        const key = `${prefix}/${fileName}`;
        for (const cacheVersion of ['', '?v=a', '?v=b']) {
          expect(managedGymImageKey(gymUuid, kind, `/static/${key}${cacheVersion}`)).toBe(key);
        }
      }
    },
  );

  it('clears a versioned upload with a cache stamp and all of its variants', async () => {
    const key = `gym-photos/${gymUuid}.${otherGymUuid}.jpg`;
    await removeManagedGymImage(gymUuid, 'photo', `/static/${key}?v=1`);
    expect(storage.remove).toHaveBeenCalledWith('media', key);
    expect(storage.remove).toHaveBeenCalledTimes(1 + ALLOWED_IMAGE_SIZES.length);
  });

  it('preserves object identity across trusted backend and configured CDN display URLs', () => {
    const key = `gym-logos/${gymUuid}.${otherGymUuid}.jpg`;
    storage.mediaBase = 'https://media.boardsesh.test/public';
    for (const storedUrl of [
      `/static/${key}?v=old`,
      `https://api.boardsesh.com/static/${key}?v=new`,
      `https://ws.boardsesh.com/static/${key}?size=140`,
      `https://media.boardsesh.test/public/${key}?v=new#logo`,
      `https://media.boardsesh.test/public/${key}@${ALLOWED_IMAGE_SIZES[0]}.jpg`,
    ]) {
      expect(managedGymImageKey(gymUuid, 'logo', storedUrl), storedUrl).toBe(key);
    }
    for (const storedUrl of [
      `https://untrusted.example/static/${key}`,
      `https://api.boardsesh.com.attacker.example/static/${key}`,
      `https://media.boardsesh.test/unrelated/${key}`,
      `https://api.boardsesh.com/static/gym-logos/${otherGymUuid}.jpg`,
    ]) {
      expect(managedGymImageKey(gymUuid, 'logo', storedUrl)).toBeNull();
    }
  });

  it.each([
    `/static/gym-photos/${otherGymUuid}.jpg?v=old`,
    `/static/gym-logos/${gymUuid}.jpg?v=old`,
    `https://images.example/${gymUuid}.jpg`,
    `/static/gym-photos/${gymUuid}.jpg/../../other.jpg`,
  ])('leaves unrelated objects untouched: %s', async (storedUrl) => {
    await removeManagedGymImage(gymUuid, 'photo', storedUrl);
    expect(storage.remove).not.toHaveBeenCalled();
  });
});
