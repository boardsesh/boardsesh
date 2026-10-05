import { describe, expect, it } from 'vitest';
import { sprayPhotoObjectIdentity } from '../spray-draft-purpose';

describe('immutable private photo identity', () => {
  it('uses the same key across signed URLs and bucket addressing styles', () => {
    expect(sprayPhotoObjectIdentity('https://bucket.s3.example/spray-walls/aaaa/bbbb.jpg?signature=one')).toBe(
      'spray-walls/aaaa/bbbb.jpg',
    );
    expect(sprayPhotoObjectIdentity('https://s3.example/bucket/spray-walls/aaaa/bbbb.jpg?signature=two')).toBe(
      'spray-walls/aaaa/bbbb.jpg',
    );
  });

  it.each([undefined, null, '', 'bad-url', 'https://example/other.jpg'])('fails closed for %s', (url) => {
    expect(sprayPhotoObjectIdentity(url)).toBeNull();
  });
});
