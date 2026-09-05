// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Boardsesh contributors

import { describe, it, expect } from 'vitest';
import { deriveKey, KEY_LENGTH } from '../key-derivation';

describe('deriveKey', () => {
  it('produces consistent output for same input', () => {
    const secret = 'my-secret-key';
    const key1 = deriveKey(secret);
    const key2 = deriveKey(secret);
    expect(key1).toEqual(key2);
  });

  it('produces different keys for different secrets', () => {
    const key1 = deriveKey('secret1');
    const key2 = deriveKey('secret2');
    expect(key1).not.toEqual(key2);
  });

  it('returns correct key length for AES-256', () => {
    const key = deriveKey('test-secret');
    // AES-256 requires 32 bytes (256 bits)
    expect(key.length).toBe(KEY_LENGTH);
    expect(key.length).toBe(32);
  });

  it('produces valid Buffer output', () => {
    const key = deriveKey('test');
    expect(Buffer.isBuffer(key)).toBe(true);
  });

  it('handles empty string secret', () => {
    // Should still produce a valid key, even if not recommended
    const key = deriveKey('');
    expect(key.length).toBe(KEY_LENGTH);
  });

  it('handles very long secrets', () => {
    const longSecret = 'x'.repeat(1000);
    const key = deriveKey(longSecret);
    expect(key.length).toBe(KEY_LENGTH);
  });

  it('handles special characters in secret', () => {
    const key = deriveKey('!@#$%^&*()_+-=[]{}|;:,.<>?');
    expect(key.length).toBe(KEY_LENGTH);
  });

  it('handles unicode characters in secret', () => {
    const key = deriveKey('🔐 Secret 密钥');
    expect(key.length).toBe(KEY_LENGTH);
  });
});
