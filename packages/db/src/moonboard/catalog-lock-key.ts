export const MOONBOARD_CATALOG_IMPORT_LOCK_NAME = 'boardsesh:moonboard-catalog-import';

/**
 * FNV-1a, 64-bit, hashed over the input's UTF-8 bytes. A small, well-known,
 * dependency-free hash, chosen so the key below can be recomputed by hand
 * from the name above — useful when a `pg_locks` row shows the key and
 * someone needs to confirm what it is.
 *
 * Hashes bytes, not JS's UTF-16 code units: the textbook FNV-1a definition is
 * over an octet sequence, and `MOONBOARD_CATALOG_IMPORT_LOCK_NAME` is pure
 * ASCII so the two happen to agree for it today, but hashing code units
 * directly would silently diverge from the standard algorithm — and from
 * every other language's FNV-1a implementation — the moment the name (or a
 * future caller's input) contains anything outside ASCII, breaking the
 * "recompute by hand" promise above.
 * https://en.wikipedia.org/wiki/Fowler%E2%80%93Noll%E2%80%93Vo_hash_function
 */
export function fnv1a64(input: string): bigint {
  const OFFSET_BASIS = 0xcbf29ce484222325n;
  const PRIME = 0x100000001b3n;
  const MASK_64_BITS = (1n << 64n) - 1n;
  let hash = OFFSET_BASIS;
  for (const byte of new TextEncoder().encode(input)) {
    hash = (hash ^ BigInt(byte)) & MASK_64_BITS;
    hash = (hash * PRIME) & MASK_64_BITS;
  }
  return hash;
}

// pg_try_advisory_lock takes a signed bigint. Masking off the top bit keeps
// the hash inside the positive int64 range without two's-complement
// arithmetic, at the cost of one bit of entropy this use has no need for.
const MASK_63_BITS = (1n << 63n) - 1n;

/** The advisory-lock key, derived once from MOONBOARD_CATALOG_IMPORT_LOCK_NAME above. */
export const MOONBOARD_CATALOG_IMPORT_LOCK_KEY: bigint = fnv1a64(MOONBOARD_CATALOG_IMPORT_LOCK_NAME) & MASK_63_BITS;

