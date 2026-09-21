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

type ProvenFingerprintForms = {
  storedFingerprint: string;
  rawFingerprint: string;
  hasStoredRows: boolean;
};

function provenFingerprintForms(row: LegacyFingerprintCompatibilityRow): ProvenFingerprintForms | null {
  const rawEvents = legacyAuroraRawFrameHoldEvents(row.frames, KILTER);
  if (rawEvents.length === 0) return null;
  const projectedRows = projectAuroraFramesToStoredRows(row.frames, KILTER).rows;
  const rawFingerprint = fingerprintFromHolds(rawEvents);
  const projectedFingerprint = fingerprintFromHolds(projectedRows);
  if (row.fingerprint !== rawFingerprint && row.fingerprint !== projectedFingerprint) return null;
  return { storedFingerprint: row.fingerprint, rawFingerprint, hasStoredRows: projectedRows.length > 0 };
}

/**
 * Build exact raw-event owners while accepting both historical raw hashes and
 * repaired projected hashes already stored in the database.
 *
 * Compatibility rows are evidence about one UUID, never alias keys. A lossy
 * projected hash is suppressed for that animated row and replaced by its proven
 * raw hash. Iterating every stored row in database UUID order lets a later true
 * single-frame owner reclaim the projected key instead of disappearing behind
 * the animated row that sorted first.
 */
export function enrichFingerprintOwnersWithLegacyCompatibility(
  storedRows: ReadonlyArray<StoredFingerprintOwnerRow>,
  compatibilityRows: ReadonlyArray<LegacyFingerprintCompatibilityRow>,
): Map<string, string> {
  const formsByLowerUuid = new Map<string, ProvenFingerprintForms>();
  for (const row of compatibilityRows) {
    const forms = provenFingerprintForms(row);
    if (forms) formsByLowerUuid.set(row.uuid.toLowerCase(), forms);
  }

  const owners = new Map<string, string>();
  for (const row of storedRows) {
    if (!row.fingerprint) continue;
    const candidateForms = formsByLowerUuid.get(row.uuid.toLowerCase());
    const forms = candidateForms?.storedFingerprint === row.fingerprint ? candidateForms : undefined;
    // Empty projections have no usable hold identity. The writer gives incoming
    // climbs in this class NULL rather than letting SHA256('') alias them.
    if (forms && !forms.hasStoredRows) continue;
    const fingerprint = forms?.rawFingerprint ?? row.fingerprint;
    if (!owners.has(fingerprint)) owners.set(fingerprint, row.uuid);
  }
  return owners;
}

/**
 * Expand a reroute DB lookup with stored projected hashes only when that row's
 * frames prove the candidate's exact raw-event fingerprint. Returned projected
 * keys broaden the fetch; they are never used as dedup identities.
 */
export function storedFingerprintsForRawCandidates(
  candidateFingerprints: ReadonlySet<string>,
  compatibilityRows: ReadonlyArray<LegacyFingerprintCompatibilityRow>,
): string[] {
  const lookup = new Set(candidateFingerprints);
  for (const row of compatibilityRows) {
    const forms = provenFingerprintForms(row);
    if (!forms?.hasStoredRows || !candidateFingerprints.has(forms.rawFingerprint)) continue;
    lookup.add(row.fingerprint);
  }
  return [...lookup];
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
  fingerprintEvents: ReadonlyArray<HoldTuple>,
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
  const fingerprint = fingerprintFromHolds(fingerprintEvents);
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
