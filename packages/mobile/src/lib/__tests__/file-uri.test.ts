import { describe, expect, it } from 'vitest';
import { decodeFileUri } from '../file-uri';

describe('decodeFileUri', () => {
  it('decodes the %2C Android writes between set ids, keeping the scheme', () => {
    expect(decodeFileUri('file:///data/cache/board-thumbnails/v16_f_w384_moonboard_2_1_1%2C2%2C3_ab.png')).toBe(
      'file:///data/cache/board-thumbnails/v16_f_w384_moonboard_2_1_1,2,3_ab.png',
    );
  });

  it('decodes a scheme-less path cut from an encoded URI', () => {
    expect(decodeFileUri('/data/cache/Exponent%20Asset-ab.webp')).toBe('/data/cache/Exponent Asset-ab.webp');
  });

  it('leaves an already-plain URI unchanged', () => {
    const plain = 'file:///data/cache/board-thumbnails/v16_f_w384_kilter_1_10_1,20_ab.png';
    expect(decodeFileUri(plain)).toBe(plain);
  });

  it('returns a string with a malformed escape untouched', () => {
    expect(decodeFileUri('file:///data/cache/100%_ab.png')).toBe('file:///data/cache/100%_ab.png');
  });
});
