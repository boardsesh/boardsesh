import { describe, expect, it } from 'vitest';
import { CONNECT_STEP_SALT, assignConnectStepArm, isConnectStepArm, murmurHash3x86_32 } from '../connect-step-arm';

const UTF8_E_ACUTE_HASH = 269551495;
const UTF8_CLIMBER_HASH = 3006529272;

// The arm must be recomputable offline (HogQL's `murmurHash3_32`), so the hash
// is pinned against MurmurHash3 x86_32's published reference vectors rather
// than against whatever this implementation happens to return.
describe('murmurHash3x86_32', () => {
  it.each([
    ['', 0],
    ['hello', 613153351],
    ['The quick brown fox jumps over the lazy dog', 0x2e4ff723],
  ])('matches the reference value for %j', (text, expected) => {
    expect(murmurHash3x86_32(text)).toBe(expected);
  });

  it('covers every tail length', () => {
    // 1-, 2- and 3-byte tails each take their own branch; none may throw or
    // collide with its neighbour.
    const hashes = ['a', 'ab', 'abc', 'abcd', 'abcde'].map(murmurHash3x86_32);
    expect(new Set(hashes).size).toBe(hashes.length);
    for (const hash of hashes) {
      expect(hash).toBeGreaterThanOrEqual(0);
      expect(hash).toBeLessThanOrEqual(0xffffffff);
    }
  });

  it('hashes the UTF-8 bytes, like ClickHouse, not UTF-16 code units', () => {
    // Expected values from murmurhash-js over the UTF-8 bytes as a binary string.
    expect(murmurHash3x86_32('é')).toBe(UTF8_E_ACUTE_HASH);
    expect(murmurHash3x86_32('climb 🧗')).toBe(UTF8_CLIMBER_HASH);
  });
});

describe('assignConnectStepArm', () => {
  // Pinned with an independent implementation (murmurhash-js) over the same
  // input, `${userId}:${CONNECT_STEP_SALT}`.
  it.each([
    ['00000000-0000-4000-8000-000000000001', 'treatment'],
    ['3f2b9c1e-7d4a-4e8b-9c2d-5a6b7c8d9e0f', 'treatment'],
    ['a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d', 'control'],
  ] as const)('puts %s in %s', (userId, arm) => {
    expect(assignConnectStepArm(userId)).toBe(arm);
  });

  it('is the odd/even split of the salted hash', () => {
    const userId = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
    const hash = murmurHash3x86_32(`${userId}:${CONNECT_STEP_SALT}`);
    expect(assignConnectStepArm(userId)).toBe(hash % 2 === 1 ? 'treatment' : 'control');
  });

  it('gives the same account the same arm every time', () => {
    const userId = '3f2b9c1e-7d4a-4e8b-9c2d-5a6b7c8d9e0f';
    const arms = new Set(Array.from({ length: 20 }, () => assignConnectStepArm(userId)));
    expect(arms.size).toBe(1);
  });

  it('splits accounts close to 50/50', () => {
    let treatment = 0;
    const total = 4000;
    for (let index = 0; index < total; index += 1) {
      const suffix = index.toString(16).padStart(12, '0');
      if (assignConnectStepArm(`00000000-0000-4000-8000-${suffix}`) === 'treatment') treatment += 1;
    }
    // 4000 draws: three standard deviations is about ±95.
    expect(Math.abs(treatment - total / 2)).toBeLessThan(120);
  });
});

describe('isConnectStepArm', () => {
  it('accepts only the two arms', () => {
    expect(isConnectStepArm('treatment')).toBe(true);
    expect(isConnectStepArm('control')).toBe(true);
    expect(isConnectStepArm('Treatment')).toBe(false);
    expect(isConnectStepArm(true)).toBe(false);
    expect(isConnectStepArm(undefined)).toBe(false);
  });
});
