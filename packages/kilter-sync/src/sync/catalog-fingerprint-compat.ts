import {
  legacyAuroraRawFrameHoldEvents,
  projectAuroraFramesToStoredRows,
} from '@boardsesh/board-constants/hold-states';

import { fingerprintFromHolds, type HoldTuple } from './fingerprint';

const KILTER = 'kilter';

export type LegacyFingerprintCompatibilityRow = {
  layoutId: number;
  uuid: string;
  frames: string;
  fingerprint: string;
};

export type StoredFingerprintOwnerRow = {
  uuid: string;
  fingerprint: string | null;
};

/** Keep the first row for each stored fingerprint; callers define its stable order. */
export function indexStoredFingerprintOwners(rows: ReadonlyArray<StoredFingerprintOwnerRow>): Map<string, string> {
  const fingerprintOwners = new Map<string, string>();
  for (const row of rows) {
    if (row.fingerprint && !fingerprintOwners.has(row.fingerprint)) {
      fingerprintOwners.set(row.fingerprint, row.uuid);
    }
  }
  return fingerprintOwners;
}

/** Partition one catalog-wide preload into the rows needed by each layout group. */
export function partitionLegacyFingerprintCompatibilityRows(
  rows: ReadonlyArray<LegacyFingerprintCompatibilityRow>,
): Map<number, LegacyFingerprintCompatibilityRow[]> {
  const rowsByLayout = new Map<number, LegacyFingerprintCompatibilityRow[]>();
  for (const row of rows) {
    const layoutRows = rowsByLayout.get(row.layoutId) ?? [];
    layoutRows.push(row);
    rowsByLayout.set(row.layoutId, layoutRows);
  }
  return rowsByLayout;
}

/**
 * Add temporary projected-hash lookup keys for rows whose stored fingerprint
 * is proven to be the pre-6e93 raw-event hash. The stored index remains the
 * authority: compatibility keys never replace an owner and never mutate the
 * caller's map.
 */
export function enrichFingerprintOwnersWithLegacyCompatibility(
  storedFingerprintOwners: ReadonlyMap<string, string>,
  compatibilityRows: ReadonlyArray<LegacyFingerprintCompatibilityRow>,
): Map<string, string> {
  const enrichedFingerprintOwners = new Map(storedFingerprintOwners);

  for (const row of compatibilityRows) {
    const legacyEvents = legacyAuroraRawFrameHoldEvents(row.frames, KILTER);
    if (legacyEvents.length === 0) continue;

    const legacyFingerprint = fingerprintFromHolds(legacyEvents);
    if (row.fingerprint !== legacyFingerprint) continue;
    if (storedFingerprintOwners.get(row.fingerprint) !== row.uuid) continue;

    const projectedRows = projectAuroraFramesToStoredRows(row.frames, KILTER).rows;
    if (projectedRows.length === 0) continue;

    const projectedFingerprint = fingerprintFromHolds(projectedRows);
    if (enrichedFingerprintOwners.has(projectedFingerprint)) continue;
    enrichedFingerprintOwners.set(projectedFingerprint, row.uuid);
  }

  return enrichedFingerprintOwners;
}

export type CatalogFingerprintDecision = {
  /** `null` when the climb projects to no holds — see `decideCatalogFingerprint`. */
  fingerprint: string | null;
  canonicalUuid: string;
  canonicalToInsert: string | null;
  holdRowsToInsert: HoldTuple[];
};

/**
 * Pure fingerprint decision used by the catalog's alias-vs-canonical branch.
 *
 * A climb that projects to no stored rows — every token an unknown role or a
 * nonpositive placement — has no hold identity to dedup on. Hashing it anyway
 * yields SHA256(''), the constant the repair script clears back to NULL, and
 * would make the first hold-less climb the canonical for every later one. Such
 * a climb is inserted as its own canonical with a NULL fingerprint and never
 * enters the owner index, matching `enrichFingerprintOwnersWithLegacyCompatibility`.
 */
export function decideCatalogFingerprint(
  fingerprintOwners: ReadonlyMap<string, string>,
  incomingUuid: string,
  projectedRows: ReadonlyArray<HoldTuple>,
): CatalogFingerprintDecision {
  const holdRowsToInsert = [...projectedRows];
  if (holdRowsToInsert.length === 0) {
    return {
      fingerprint: null,
      canonicalUuid: incomingUuid,
      canonicalToInsert: incomingUuid,
      holdRowsToInsert,
    };
  }
  const fingerprint = fingerprintFromHolds(holdRowsToInsert);
  const existingCanonicalUuid = fingerprintOwners.get(fingerprint);
  if (existingCanonicalUuid) {
    return {
      fingerprint,
      canonicalUuid: existingCanonicalUuid,
      canonicalToInsert: null,
      holdRowsToInsert: [],
    };
  }
  return {
    fingerprint,
    canonicalUuid: incomingUuid,
    canonicalToInsert: incomingUuid,
    holdRowsToInsert,
  };
}
