// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Boardsesh contributors

import { describe, it, expect } from 'vitest';
import { encrypt, decrypt, isEncrypted } from '../crypto';

describe('encrypt and decrypt', () => {
  it('roundtrips plaintext correctly', () => {
    const plaintext = 'Hello, World!';
    const encrypted = encrypt(plaintext);
    const decrypted = decrypt(encrypted);
    expect(decrypted).toBe(plaintext);
  });

  it('handles empty strings', () => {
    const plaintext = '';
    const encrypted = encrypt(plaintext);
    const decrypted = decrypt(encrypted);
    expect(decrypted).toBe(plaintext);
  });

  it('handles unicode and emoji characters', () => {
    const plaintext = '🧗‍♀️ Climbing! 日本語 émojis';
    const encrypted = encrypt(plaintext);
    const decrypted = decrypt(encrypted);
    expect(decrypted).toBe(plaintext);
  });

  it('handles long strings', () => {
    const plaintext = 'A'.repeat(10000);
    const encrypted = encrypt(plaintext);
    const decrypted = decrypt(encrypted);
    expect(decrypted).toBe(plaintext);
  });

  it('produces different ciphertext for same plaintext', () => {
    const plaintext = 'test';
    const encrypted1 = encrypt(plaintext);
    const encrypted2 = encrypt(plaintext);
    // Different IVs should produce different ciphertext
    expect(encrypted1).not.toBe(encrypted2);
    // But both should decrypt to the same plaintext
    expect(decrypt(encrypted1)).toBe(plaintext);
    expect(decrypt(encrypted2)).toBe(plaintext);
  });

  it('throws on tampered ciphertext', () => {
    const encrypted = encrypt('test');
    // Flip the bits of the final ciphertext byte to corrupt the auth tag.
    // (Replacing the last base64 character was flaky: the replacement could
    // equal the original, or differ only in base64's unused trailing bits.)
    const tamperedBytes = Buffer.from(encrypted, 'base64');
    tamperedBytes[tamperedBytes.length - 1] ^= 0xff;
    const tampered = tamperedBytes.toString('base64');
    expect(() => decrypt(tampered)).toThrow();
  });

  it('throws on invalid base64', () => {
    expect(() => decrypt('not-valid-base64!!!')).toThrow();
  });

  it('throws on ciphertext that is too short', () => {
    // Need at least IV (16) + AuthTag (16) + 1 byte = 33 bytes
    const shortBase64 = Buffer.from('short').toString('base64');
    expect(() => decrypt(shortBase64)).toThrow();
  });
});

describe('isEncrypted', () => {
  it('returns true for encrypted strings', () => {
    const encrypted = encrypt('test');
    expect(isEncrypted(encrypted)).toBe(true);
  });

  it('returns true for properly formatted encrypted data', () => {
    const encrypted = encrypt('Hello, World!');
    expect(isEncrypted(encrypted)).toBe(true);
  });

  it('returns false for plain text', () => {
    expect(isEncrypted('hello world')).toBe(false);
  });

  it('returns false for short base64 strings', () => {
    // 'test' in base64 - too short to be valid encrypted data
    expect(isEncrypted('dGVzdA==')).toBe(false);
  });

  it('returns false for invalid base64', () => {
    expect(isEncrypted('not valid base64!!!')).toBe(false);
  });

  it('returns false for empty strings', () => {
    expect(isEncrypted('')).toBe(false);
  });

  it('returns false for strings that look like base64 but are too short', () => {
    // Valid base64 but shorter than IV + AuthTag + 1 byte (33 bytes)
    const shortValid = Buffer.from('short').toString('base64');
    expect(isEncrypted(shortValid)).toBe(false);
  });
});
