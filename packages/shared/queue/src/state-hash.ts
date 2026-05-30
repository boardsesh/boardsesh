/**
 * Queue state hashing — the single source of truth for both web and backend.
 *
 * Both sides compute this hash independently and compare them to detect drift
 * (the 60s client watchdog, reconnect reconciliation, server no-op detection).
 * They MUST produce identical output for identical queues, so there is exactly
 * one implementation and both import it from here. A previous duplicate-copy
 * setup drifted: the web copy filtered malformed items, the backend copy did
 * not, so a queue item with a missing/null `uuid` hashed differently on each
 * side and the watchdog looped forever (issue #2359).
 *
 * This is NOT a cryptographic hash — use only for integrity checking and
 * detecting state drift, not for security.
 */

/**
 * FNV-1a 32-bit hash.
 * https://en.wikipedia.org/wiki/Fowler%E2%80%93Noll%E2%80%93Vo_hash_function
 */
export function fnv1aHash(str: string): string {
  const FNV_PRIME = 0x01000193;
  const FNV_OFFSET_BASIS = 0x811c9dc5;

  let hash = FNV_OFFSET_BASIS;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, FNV_PRIME);
  }

  // Convert to unsigned 32-bit integer and return as zero-padded hex.
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/**
 * Compute a deterministic hash of queue state: sorted queue UUIDs + current
 * item UUID. Only UUIDs contribute — climb metadata is intentionally ignored.
 *
 * Malformed entries (null/undefined items, or items without a string `uuid`)
 * are filtered out before hashing. This keeps the hash crash-safe and, more
 * importantly, invariant to the shape corruption that the reducer's
 * `climb != null` filter lets through — so client and server agree even when a
 * queue item is missing its uuid.
 */
export function computeQueueStateHash(
  queue: Array<{ uuid: string } | null | undefined>,
  currentItemUuid: string | null,
): string {
  const queueUuids = queue
    .filter((item): item is { uuid: string } => item != null && typeof item === 'object' && item.uuid != null)
    .map((item) => item.uuid)
    .sort()
    .join(',');
  const currentUuid = currentItemUuid || 'null';

  const canonical = `${queueUuids}|${currentUuid}`;

  return fnv1aHash(canonical);
}
