// Which arm of the connect-step test (#5654, PR 7) an account belongs to.
//
// Computed on the phone from the account id alone, with no PostHog flag: a flag
// has no cached value on a first launch, which is exactly the launch this test
// is about, and an arm that changed once the flag landed would put one climber
// in both arms. The same id always lands in the same arm, on every phone and
// every reinstall, and anyone can recompute it offline.
//
// The hash is MurmurHash3 x86_32 with seed 0 over the UTF-8 bytes, which is
// ClickHouse's `murmurHash3_32`, so an analyst can check an arm in HogQL:
//
//   murmurHash3_32(concat(user_id, ':first-connect-cta-v1')) % 2   -- 1 = treatment
//
// Web never reuses this: its climbing surface is retired, so the connect step
// has nothing to run on there. That is why it lives in the mobile lib and not
// in a shared package.

/**
 * Salt for this test only. A later test must use its own salt, or it would
 * split climbers along exactly the same line and inherit this test's effect.
 * Changing it re-deals every account, so it never changes while the test runs.
 */
export const CONNECT_STEP_SALT = 'first-connect-cta-v1';

export const CONNECT_STEP_ARMS = ['treatment', 'control'] as const;
export type ConnectStepArm = (typeof CONNECT_STEP_ARMS)[number];

export function isConnectStepArm(value: unknown): value is ConnectStepArm {
  return value === 'treatment' || value === 'control';
}

function utf8Bytes(text: string): number[] {
  const bytes: number[] = [];
  for (const character of text) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint < 0x80) {
      bytes.push(codePoint);
    } else if (codePoint < 0x800) {
      bytes.push(0xc0 | (codePoint >> 6), 0x80 | (codePoint & 0x3f));
    } else if (codePoint < 0x10000) {
      bytes.push(0xe0 | (codePoint >> 12), 0x80 | ((codePoint >> 6) & 0x3f), 0x80 | (codePoint & 0x3f));
    } else {
      bytes.push(
        0xf0 | (codePoint >> 18),
        0x80 | ((codePoint >> 12) & 0x3f),
        0x80 | ((codePoint >> 6) & 0x3f),
        0x80 | (codePoint & 0x3f),
      );
    }
  }
  return bytes;
}

/**
 * MurmurHash3 x86_32, seed 0, over the UTF-8 bytes of `text`. Unsigned 32-bit.
 * Matches ClickHouse's `murmurHash3_32` (and the reference vectors in the test).
 */
export function murmurHash3x86_32(text: string): number {
  const bytes = utf8Bytes(text);
  const blockMultiplier1 = 0xcc9e2d51;
  const blockMultiplier2 = 0x1b873593;
  let hash = 0;
  const wholeBlockBytes = bytes.length - (bytes.length % 4);

  for (let offset = 0; offset < wholeBlockBytes; offset += 4) {
    let block =
      (bytes[offset] ?? 0) |
      ((bytes[offset + 1] ?? 0) << 8) |
      ((bytes[offset + 2] ?? 0) << 16) |
      ((bytes[offset + 3] ?? 0) << 24);
    block = Math.imul(block, blockMultiplier1);
    block = (block << 15) | (block >>> 17);
    block = Math.imul(block, blockMultiplier2);
    hash ^= block;
    hash = (hash << 13) | (hash >>> 19);
    hash = (Math.imul(hash, 5) + 0xe6546b64) | 0;
  }

  let tail = 0;
  switch (bytes.length & 3) {
    case 3:
      tail ^= (bytes[wholeBlockBytes + 2] ?? 0) << 16;
    // falls through
    case 2:
      tail ^= (bytes[wholeBlockBytes + 1] ?? 0) << 8;
    // falls through
    case 1:
      tail ^= bytes[wholeBlockBytes] ?? 0;
      tail = Math.imul(tail, blockMultiplier1);
      tail = (tail << 15) | (tail >>> 17);
      tail = Math.imul(tail, blockMultiplier2);
      hash ^= tail;
  }

  hash ^= bytes.length;
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x85ebca6b);
  hash ^= hash >>> 13;
  hash = Math.imul(hash, 0xc2b2ae35);
  hash ^= hash >>> 16;
  return hash >>> 0;
}

/** The account's arm: an odd hash is treatment, an even one control. */
export function assignConnectStepArm(userId: string): ConnectStepArm {
  return murmurHash3x86_32(`${userId}:${CONNECT_STEP_SALT}`) % 2 === 1 ? 'treatment' : 'control';
}
