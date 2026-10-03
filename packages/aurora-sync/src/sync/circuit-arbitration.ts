import { sql, type SQL } from 'drizzle-orm';
import type { AuroraBoardName } from '../api/types';

/**
 * Text namespace embedded in PostgreSQL's server-side 64-bit advisory-lock
 * hash. There is no playlist row to lock when two users concurrently claim a
 * new circuit, so every circuit writer must serialize on this key before its
 * first source or playlist write.
 */
const AURORA_CIRCUIT_LOCK_KEY_PREFIX = 'boardsesh:aurora-circuit';

export type NormalizedAuroraCircuitItems<CircuitItem> = {
  items: Array<CircuitItem & { uuid: string }>;
  rejectedCount: number;
};

/**
 * De-duplicate Aurora circuit rows with their conventional last-row-wins
 * semantics and return them in a stable lock/write order. Runtime payloads are
 * not guaranteed to honour their TypeScript shape, so missing, non-string and
 * blank UUIDs are rejected before they can become a lock key or database key.
 */
export function normalizeAuroraCircuitItems<CircuitItem extends { uuid?: unknown }>(
  circuitItems: readonly CircuitItem[],
): NormalizedAuroraCircuitItems<CircuitItem> {
  const lastItemByUuid = new Map<string, CircuitItem & { uuid: string }>();
  let rejectedCount = 0;

  for (const circuitItem of circuitItems) {
    if (
      typeof circuitItem.uuid !== 'string' ||
      circuitItem.uuid.trim().length === 0 ||
      circuitItem.uuid !== circuitItem.uuid.trim()
    ) {
      rejectedCount += 1;
      continue;
    }
    lastItemByUuid.set(circuitItem.uuid, circuitItem as CircuitItem & { uuid: string });
  }

  const items = [...lastItemByUuid.values()].sort((left, right) =>
    left.uuid < right.uuid ? -1 : left.uuid > right.uuid ? 1 : 0,
  );
  return { items, rejectedCount };
}

/** @internal Pure/testable input to PostgreSQL's `hashtextextended(text, bigint)`. */
export function getAuroraCircuitAdvisoryLockKey(boardName: AuroraBoardName, circuitUuid: string): string {
  return `${AURORA_CIRCUIT_LOCK_KEY_PREFIX}|${boardName}|${circuitUuid}`;
}

/**
 * The exact transaction-scoped advisory-lock statement shared by the daemon
 * and legacy web proxy writers.
 *
 * @internal
 */
export function auroraCircuitAdvisoryLockStatement(boardName: AuroraBoardName, circuitUuid: string): SQL {
  // Keep the 64-bit hash inside PostgreSQL. Converting it to a JavaScript
  // Number would lose precision above 2^53 and could split contenders across
  // different advisory keys.
  return sql`SELECT pg_advisory_xact_lock(hashtextextended(${getAuroraCircuitAdvisoryLockKey(boardName, circuitUuid)}, 0::bigint))`;
}
