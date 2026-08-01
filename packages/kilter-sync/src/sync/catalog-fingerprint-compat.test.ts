import { describe, expect, it } from 'vite-plus/test';
import {
  legacyAuroraRawFrameHoldEvents,
  projectAuroraFramesToStoredRows,
} from '@boardsesh/board-constants/hold-states';

import {
  decideCatalogFingerprint,
  enrichFingerprintOwnersWithLegacyCompatibility,
  partitionLegacyFingerprintCompatibilityRows,
  type LegacyFingerprintCompatibilityRow,
} from './catalog-fingerprint-compat';
import { decodeGripsClimbConcat } from './catalog-parse';
import { fingerprintFromHolds } from './fingerprint';

function legacyFingerprint(frames: string): string {
  return fingerprintFromHolds(legacyAuroraRawFrameHoldEvents(frames, 'kilter'));
}

function projectedFingerprint(frames: string): string {
  return fingerprintFromHolds(projectAuroraFramesToStoredRows(frames, 'kilter').rows);
}

function compatibilityRow(
  uuid: string,
  frames: string,
  fingerprint = legacyFingerprint(frames),
  layoutId = 1,
): LegacyFingerprintCompatibilityRow {
  return { layoutId, uuid, frames, fingerprint };
}

describe('legacy fingerprint compatibility index', () => {
  it('partitions the single preload by layout without reordering rows', () => {
    const rows = [compatibilityRow('layout-8-a', 'p1r12', undefined, 8), compatibilityRow('layout-1', 'p2r13')];
    const partitioned = partitionLegacyFingerprintCompatibilityRows([
      ...rows,
      compatibilityRow('layout-8-b', 'p3r14', undefined, 8),
    ]);

    expect(partitioned.get(1)?.map((row) => row.uuid)).toEqual(['layout-1']);
    expect(partitioned.get(8)?.map((row) => row.uuid)).toEqual(['layout-8-a', 'layout-8-b']);
  });

  it('bridges relights and unknown sentinels only after proving their legacy hashes', () => {
    const relight = compatibilityRow('historical-relight', 'p1r12,"x1p1r13');
    const unknownThenValid = compatibilityRow('historical-unknown', 'p2r999,"p2r13');
    const storedOwners = new Map([
      [relight.fingerprint, relight.uuid],
      [unknownThenValid.fingerprint, unknownThenValid.uuid],
    ]);

    const enriched = enrichFingerprintOwnersWithLegacyCompatibility(storedOwners, [relight, unknownThenValid]);

    expect(relight.fingerprint).not.toBe(projectedFingerprint(relight.frames));
    expect(legacyAuroraRawFrameHoldEvents(unknownThenValid.frames, 'kilter')[0]?.holdState).toBe('2=999');
    expect(enriched.get(projectedFingerprint(relight.frames))).toBe(relight.uuid);
    expect(enriched.get(projectedFingerprint(unknownThenValid.frames))).toBe(unknownThenValid.uuid);
    expect(storedOwners.has(projectedFingerprint(relight.frames))).toBe(false);
  });

  it('rejects independent fingerprints and rows that are not the stored fingerprint primary owner', () => {
    const independent = compatibilityRow('independent', 'p1r12,"p1r13', 'independent-source');
    const duplicateOwner = compatibilityRow('secondary-owner', 'p2r12,"p2r13');
    const storedOwners = new Map([
      [independent.fingerprint, independent.uuid],
      [duplicateOwner.fingerprint, 'primary-owner'],
    ]);

    const enriched = enrichFingerprintOwnersWithLegacyCompatibility(storedOwners, [independent, duplicateOwner]);

    expect(enriched.has(projectedFingerprint(independent.frames))).toBe(false);
    expect(enriched.has(projectedFingerprint(duplicateOwner.frames))).toBe(false);
  });

  it('never replaces a projected primary owner or indexes an empty projection', () => {
    const occupiedProjection = compatibilityRow('historical', 'p1r12,"p1r13');
    const emptyProjection = compatibilityRow('invalid-only', 'p0r12,"p-2r13');
    const existingProjectedOwner = 'already-current-owner';
    const storedOwners = new Map([
      [occupiedProjection.fingerprint, occupiedProjection.uuid],
      [projectedFingerprint(occupiedProjection.frames), existingProjectedOwner],
      [emptyProjection.fingerprint, emptyProjection.uuid],
    ]);

    const enriched = enrichFingerprintOwnersWithLegacyCompatibility(storedOwners, [
      occupiedProjection,
      emptyProjection,
    ]);

    expect(enriched.get(projectedFingerprint(occupiedProjection.frames))).toBe(existingProjectedOwner);
    expect(projectAuroraFramesToStoredRows(emptyProjection.frames, 'kilter').rows).toEqual([]);
    expect(enriched.has(fingerprintFromHolds([]))).toBe(false);
  });

  it('leaves current rows unchanged and keeps the first bridge when legacy encodings share a projection', () => {
    const currentFrames = 'p1r12,"x1p1r13';
    const current = compatibilityRow('already-repaired', currentFrames, projectedFingerprint(currentFrames));
    const first = compatibilityRow('first-legacy-owner', 'p2r12,"x2p2r13');
    const second = compatibilityRow('second-legacy-owner', 'p2r12,"x2p2r14');
    const storedOwners = new Map([
      [current.fingerprint, current.uuid],
      [first.fingerprint, first.uuid],
      [second.fingerprint, second.uuid],
    ]);

    const enriched = enrichFingerprintOwnersWithLegacyCompatibility(storedOwners, [current, first, second]);

    expect(enriched.size).toBe(storedOwners.size + 1);
    expect(enriched.get(projectedFingerprint(currentFrames))).toBe(current.uuid);
    expect(projectedFingerprint(first.frames)).toBe(projectedFingerprint(second.frames));
    expect(enriched.get(projectedFingerprint(first.frames))).toBe(first.uuid);
  });

  it('bridges a delayed-start animation using its original legacy frame ordinal', () => {
    const decoded = decodeGripsClimbConcat('h10p13s2', new Map([[10, 100]]), 2);
    if (!decoded.ok) throw new Error(`unexpected decode failure: ${decoded.reason}`);
    expect(decoded.frames).toBe(',"p100r13');
    expect(legacyAuroraRawFrameHoldEvents(decoded.frames, 'kilter')).toEqual([
      { holdId: 100, frameNumber: 1, holdState: 'HAND' },
    ]);
    expect(decoded.holds).toEqual([{ holdId: 100, frameNumber: 0, holdState: 'HAND' }]);

    const historical = compatibilityRow('historical-canonical', decoded.frames);
    expect(historical.fingerprint).not.toBe(fingerprintFromHolds(decoded.holds));
    const enriched = enrichFingerprintOwnersWithLegacyCompatibility(
      new Map([[historical.fingerprint, historical.uuid]]),
      [historical],
    );
    expect(enriched.get(fingerprintFromHolds(decoded.holds))).toBe(historical.uuid);

    const decision = decideCatalogFingerprint(enriched, 'incoming-alias', decoded.holds);

    expect(decision.canonicalUuid).toBe(historical.uuid);
    expect(decision.canonicalToInsert).toBeNull();
    expect(decision.holdRowsToInsert).toEqual([]);
  });
});
