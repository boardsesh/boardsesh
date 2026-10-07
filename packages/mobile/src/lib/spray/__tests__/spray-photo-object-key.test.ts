import { describe, expect, it } from 'vitest';
import { sprayFullPhotoFileName, sprayPhotoObjectFromUrl } from '../spray-photo-keys';

// The object key, not the signed URL around it, is a wall photo's identity: a
// new upload gets a new random photo id, and nothing ever writes to a key twice.
const WALL = '0f0e0d0c-0b0a-4908-8706-050403020100';
const PHOTO = '11111111-2222-4333-8444-555555555555';
const KEY = `spray-walls/${WALL}/${PHOTO}.jpg`;

describe('sprayPhotoObjectFromUrl', () => {
  it.each([
    ['path-style', `https://acct.r2.cloudflarestorage.com/private/${KEY}?X-Amz-Signature=abc&X-Amz-Expires=900`],
    ['virtual-hosted', `https://private.acct.r2.cloudflarestorage.com/${KEY}?X-Amz-Signature=abc`],
    ['unsigned', `https://cdn.example/${KEY}`],
  ])('reads the base key off a %s URL', (_style, url) => {
    expect(sprayPhotoObjectFromUrl(url, WALL)).toEqual({ key: KEY, photoId: PHOTO, size: 'base' });
  });

  // Two signatures over one object are the same picture.
  it('gives the same key whatever the signature', () => {
    const first = sprayPhotoObjectFromUrl(`https://r2.example/b/${KEY}?sig=1`, WALL);
    const second = sprayPhotoObjectFromUrl(`https://r2.example/b/${KEY}?sig=2`, WALL);
    expect(first).toEqual(second);
  });

  it('tells the full-resolution copy apart from the base', () => {
    expect(sprayPhotoObjectFromUrl(`https://r2.example/b/spray-walls/${WALL}/${PHOTO}-full.jpg?sig=1`, WALL)).toEqual({
      key: `spray-walls/${WALL}/${PHOTO}-full.jpg`,
      photoId: PHOTO,
      size: 'full',
    });
  });

  // A miss only costs a download; a wrong hit would draw somebody else's wall.
  it.each([
    ['another wall', `https://r2.example/b/spray-walls/99999999-0b0a-4908-8706-050403020100/${PHOTO}.jpg`],
    ['the 280 px thumbnail', `https://r2.example/b/${KEY}@280.jpg?sig=1`],
    ['a generated look', `https://r2.example/b/spray-walls/${WALL}/art/12-r1-crop.jpg?sig=1`],
    ['a key only in the query', `https://r2.example/b/x.jpg?key=${KEY}`],
    ['a local file', `file:///documents/spray-wall-photos/x.jpg`],
    ['nothing', ''],
  ])('answers null for %s', (_case, url) => {
    expect(sprayPhotoObjectFromUrl(url, WALL)).toBeNull();
  });
});

describe('sprayFullPhotoFileName', () => {
  // The layout leads so per-wall withdrawal finds it; the photo, not the
  // version, names it so every draft on one photo shares one file.
  it('names the file after the wall and the photo', () => {
    expect(sprayFullPhotoFileName(4200, PHOTO.toUpperCase())).toBe(`4200-full-${PHOTO}.jpg`);
  });
});
