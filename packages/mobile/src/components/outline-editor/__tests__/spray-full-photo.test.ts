import { describe, expect, it, vi } from 'vitest';
import { SPRAY_FULL_PHOTO_MIN_SCALE, photoSignatureLapsed, sprayFullResolutionPhoto } from '../spray-full-photo';

const wall = { layoutId: 4200, wallUuid: 'wall-1', versionId: 30, photoExpiresAt: '2026-10-06T12:15:00.000Z' };

describe('sprayFullResolutionPhoto', () => {
  it('hands the editor the full photo, fetched past 3x', () => {
    expect(sprayFullResolutionPhoto(wall, 'https://private.example/full.jpg?sig=1')).toEqual({
      uri: 'https://private.example/full.jpg?sig=1',
      cacheKey: 'spray-full/wall-1/v30',
      minScale: SPRAY_FULL_PHOTO_MIN_SCALE,
    });
    expect(SPRAY_FULL_PHOTO_MIN_SCALE).toBe(3);
  });

  // Walls uploaded before #5911, and photos already 2048 px or smaller, have no
  // copy. The editor must keep drawing the base alone, as it always did.
  it('answers null for a wall with no full copy', () => {
    expect(sprayFullResolutionPhoto(wall, null)).toBeNull();
  });

  it('answers null before the draft has loaded', () => {
    expect(sprayFullResolutionPhoto(null, 'https://private.example/full.jpg?sig=1')).toBeNull();
  });

  // A refetch during a long sitting re-signs the URL. Keyed on the signature,
  // every refetch would download and decode 48 MB again.
  it('keys the cache on the version, not the signature', () => {
    const first = sprayFullResolutionPhoto(wall, 'https://private.example/full.jpg?sig=1');
    const resigned = sprayFullResolutionPhoto(wall, 'https://private.example/full.jpg?sig=2');
    const nextVersion = sprayFullResolutionPhoto({ ...wall, versionId: 31 }, 'https://private.example/full.jpg?sig=2');
    expect(resigned?.cacheKey).toBe(first?.cacheKey);
    expect(nextVersion?.cacheKey).not.toBe(first?.cacheKey);
  });
});

describe('sprayFullResolutionPhoto keeping the file', () => {
  // The layer asks only once the zoom passes 3x, and the request names the wall
  // so the copy is withdrawn with it.
  it('hands the layer a loader for the signed URL in hand', async () => {
    const keep = vi.fn(async () => '/cache/spray-walls/4200-full-x.jpg');
    const discard = vi.fn();
    const photo = sprayFullResolutionPhoto(wall, 'https://private.example/full.jpg?sig=1', { keep, discard });
    expect(keep).not.toHaveBeenCalled();
    expect(await photo?.loadFromDisk?.()).toBe('/cache/spray-walls/4200-full-x.jpg');
    const request = {
      layoutId: 4200,
      wallUuid: 'wall-1',
      url: 'https://private.example/full.jpg?sig=1',
      expiresAt: wall.photoExpiresAt,
    };
    expect(keep).toHaveBeenCalledWith(request);
    photo?.discardFromDisk?.();
    expect(discard).toHaveBeenCalledWith(request);
  });

  it('leaves the loader off when nothing keeps the file', () => {
    expect(sprayFullResolutionPhoto(wall, 'https://private.example/full.jpg?sig=1')?.loadFromDisk).toBeUndefined();
  });
});

describe('photoSignatureLapsed', () => {
  const expiresAt = '2026-10-06T12:15:00.000Z';
  const expiryMs = Date.parse(expiresAt);

  it('is false while the signature has time left', () => {
    expect(photoSignatureLapsed(expiresAt, expiryMs - 5 * 60 * 1000)).toBe(false);
  });

  it('is true once the signature has run out', () => {
    expect(photoSignatureLapsed(expiresAt, expiryMs + 1)).toBe(true);
  });

  // The phone's clock and the server's need not agree to the second.
  it('is true in the last minute before expiry', () => {
    expect(photoSignatureLapsed(expiresAt, expiryMs - 30 * 1000)).toBe(true);
  });

  // Refetching on a guess could loop on a photo that fails for another reason.
  it('is false for an expiry it cannot read', () => {
    expect(photoSignatureLapsed('later', expiryMs)).toBe(false);
    expect(photoSignatureLapsed('', expiryMs)).toBe(false);
  });
});
