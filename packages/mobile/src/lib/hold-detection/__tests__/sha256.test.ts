import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { Sha256, sha256Hex } from '../sha256';

function ascii(text: string): Uint8Array {
  const bytes = new Uint8Array(text.length);
  for (let index = 0; index < text.length; index += 1) bytes[index] = text.charCodeAt(index);
  return bytes;
}

/** Node's OpenSSL digest, as the oracle. Not available on a phone, which is why this file exists. */
function reference(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

describe('Sha256', () => {
  it('matches the published FIPS 180-4 vectors', () => {
    expect(sha256Hex(ascii('abc'))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(sha256Hex(ascii('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'))).toBe(
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    );
  });

  it('matches the one-million-"a" vector, which overflows a 32-bit bit count', () => {
    const hash = new Sha256();
    const chunk = ascii('a'.repeat(1000));
    for (let index = 0; index < 1000; index += 1) hash.update(chunk);
    expect(hash.digestHex()).toBe('cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0');
  });

  it('agrees with OpenSSL on the empty message', () => {
    expect(sha256Hex(new Uint8Array(0))).toBe(reference(new Uint8Array(0)));
  });

  it('agrees with OpenSSL at every padding edge case', () => {
    // 55/56 is where the 64-bit length field stops fitting in the final block.
    for (const length of [1, 54, 55, 56, 57, 63, 64, 65, 119, 120, 127, 128, 1000]) {
      const message = new Uint8Array(length).map((_, index) => (index * 31 + 7) % 256);
      expect({ length, digest: sha256Hex(message) }).toEqual({ length, digest: reference(message) });
    }
  });

  it('is independent of how the bytes are split into chunks', () => {
    // The only bug that matters for a streamed 31 MB file hash is one that shows
    // up on a particular split, so sweep every split of a multi-block message.
    const message = ascii('boardsesh spray wall hold detector '.repeat(8));
    const whole = reference(message);
    for (let split = 0; split <= message.length; split += 1) {
      const hash = new Sha256();
      hash.update(message.subarray(0, split));
      hash.update(message.subarray(split));
      expect({ split, digest: hash.digestHex() }).toEqual({ split, digest: whole });
    }
  });

  it('refuses to be updated after it was finalized', () => {
    const hash = new Sha256();
    hash.update(ascii('abc'));
    hash.digestHex();
    expect(() => hash.update(ascii('abc'))).toThrow(/after digest/);
  });
});
