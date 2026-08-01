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
  fingerprint: string;
  canonicalUuid: string;
  canonicalToInsert: string | null;
  holdRowsToInsert: HoldTuple[];
};

/** Pure fingerprint decision used by the catalog's alias-vs-canonical branch. */
export function decideCatalogFingerprint(
  fingerprintOwners: ReadonlyMap<string, string>,
  incomingUuid: string,
  projectedRows: ReadonlyArray<HoldTuple>,
): CatalogFingerprintDecision {
  const holdRowsToInsert = [...projectedRows];
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
