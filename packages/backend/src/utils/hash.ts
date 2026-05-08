/**
 * Fast non-cryptographic hash function for state verification
 * Uses FNV-1a (Fowler-Noll-Vo) algorithm - fast and good distribution
 *
 * NOTE: This is NOT a cryptographic hash - use only for integrity checking
 * and detecting state drift, not for security purposes.
 */

/**
 * FNV-1a 32-bit hash
 * https://en.wikipedia.org/wiki/Fowler%E2%80%93Noll%E2%80%93Vo_hash_function
 *
 * @param str - String to hash
 * @returns Hexadecimal hash string
 */
export function fnv1aHash(str: string): string {
  // FNV-1a parameters for 32-bit hash
  const FNV_PRIME = 0x01000193;
  const FNV_OFFSET_BASIS = 0x811c9dc5;

  let hash = FNV_OFFSET_BASIS;

  for (let i = 0; i < str.length; i++) {
    // XOR with byte
    hash ^= str.charCodeAt(i);

    // Multiply by FNV prime (with 32-bit overflow)
    hash = Math.imul(hash, FNV_PRIME);
  }

  // Convert to unsigned 32-bit integer and return as hex
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/**
 * Compute a deterministic hash of queue state
 *
 * Creates a canonical string representation of the queue state
 * (sorted queue UUIDs + current item UUID) and hashes it.
 *
 * @param queue - Array of queue item UUIDs
 * @param currentItemUuid - UUID of current climb queue item (or null)
 * @returns Hash string
 */
export function computeQueueStateHash(
  queue: Array<{ uuid: string }>,
  currentItemUuid: string | null,
  picks: Array<{ userId: string; item: { uuid: string } }> = [],
  activeClimberUserId: string | null = null,
): string {
  // Create canonical representation: sorted queue UUIDs + current UUID
  const queueUuids = queue
    .map((item) => item.uuid)
    .sort()
    .join(',');
  const currentUuid = currentItemUuid || 'null';
  const pickUuids = picks
    .map((pick) => `${pick.userId}:${pick.item.uuid}`)
    .sort()
    .join(',');
  const active = activeClimberUserId || 'null';
  const canonical = `${queueUuids}|${currentUuid}|${pickUuids}|${active}`;

  return fnv1aHash(canonical);
}
