import { randomInt } from 'node:crypto';

/**
 * The licence id printed on every file in a pack.
 *
 * It is read off paper and typed into support emails, so the alphabet drops the
 * characters that get misread: no 0/O, 1/I/L, U (reads as V in a routed
 * engrave). What is left is 30 symbols; six of them is about 29.4 bits, which
 * is not a secret and is not treated as one — the licence id identifies an
 * order, it never authorises a download on its own.
 */
export const LICENCE_ID_ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';

export const LICENCE_ID_PREFIX = 'BS-CNC-';

export const LICENCE_ID_LENGTH = 6;

const LICENCE_ID_PATTERN = new RegExp(`^${LICENCE_ID_PREFIX}[${LICENCE_ID_ALPHABET}]{${LICENCE_ID_LENGTH}}$`);

/**
 * Generate a licence id.
 *
 * `crypto.randomInt` rather than `Math.random`: with only 29 bits of space, a
 * predictable generator would let anyone enumerate the licence ids issued
 * around a known purchase, and licence ids appear in the covert fingerprint
 * trail. Collisions are handled by the caller retrying on the unique-index
 * violation, not by checking first — a check-then-insert races.
 */
export function generateLicenceId(): string {
  let suffix = '';
  for (let position = 0; position < LICENCE_ID_LENGTH; position += 1) {
    suffix += LICENCE_ID_ALPHABET[randomInt(LICENCE_ID_ALPHABET.length)];
  }
  return `${LICENCE_ID_PREFIX}${suffix}`;
}

/**
 * True for a well-formed licence id. Says nothing about whether an order exists.
 *
 * The explicit length check is not redundant with the anchored pattern: `$`
 * also matches before a trailing newline, so `"BS-CNC-ABC234\n"` would pass the
 * regex alone — and this value goes into filenames and a download route.
 */
export function isLicenceId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length === LICENCE_ID_PREFIX.length + LICENCE_ID_LENGTH &&
    LICENCE_ID_PATTERN.test(value)
  );
}
