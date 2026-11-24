import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { ALLOWED_IMAGE_SIZES } from '@boardsesh/shared-schema';

const storage = vi.hoisted(() => ({ remove: vi.fn() }));
vi.mock('../../storage/s3', () => ({
  isS3Configured: () => true,
  deleteFromS3: storage.remove,
  uploadToS3: vi.fn(),
}));

import { removeManagedGymImage, removeVersionedGymImage } from '../gym-image-storage';

const gymUuid = '11111111-1111-4111-8111-111111111111';
const otherGymUuid = '22222222-2222-4222-8222-222222222222';

describe('gym image removal', () => {
  beforeEach(() => {
    storage.remove.mockReset().mockResolvedValue(undefined);
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
