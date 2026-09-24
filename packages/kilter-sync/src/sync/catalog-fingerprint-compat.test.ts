import { describe, expect, it } from 'vite-plus/test';

import {
  decideCatalogFingerprint,
  enrichFingerprintOwnersWithLegacyCompatibility,
  partitionLegacyFingerprintCompatibilityRows,
  storedFingerprintsForRawCandidates,
  type LegacyFingerprintCompatibilityRow,
} from './catalog-fingerprint-compat';
import { decodeGripsClimbConcat } from './catalog-parse';
import { fingerprintFromHolds } from './fingerprint';

const REMAP = new Map([[10, 100]]);

function decode(concat: string, frameCount = 2) {
  const result = decodeGripsClimbConcat(concat, REMAP, frameCount);
  if (!result.ok) throw new Error(`unexpected decode failure: ${result.reason}`);
  return result;
}

function fingerprints(concat: string, frameCount = 2) {
  const decoded = decode(concat, frameCount);
  return {
    decoded,
    raw: fingerprintFromHolds(decoded.fingerprintEvents),
    projected: fingerprintFromHolds(decoded.holdRowsToInsert),
  };
}

function compatibilityRow(
  uuid: string,
  concat: string,
  storedForm: 'raw' | 'projected',
  frameCount = 2,
): LegacyFingerprintCompatibilityRow {
  const { decoded, raw, projected } = fingerprints(concat, frameCount);
  return { layoutId: 1, uuid, frames: decoded.frames, fingerprint: storedForm === 'raw' ? raw : projected };
}

describe('raw-event fingerprint compatibility index', () => {
  it('partitions the single preload by layout without reordering rows', () => {
    const first = { ...compatibilityRow('layout-8-a', 'h10p12', 'raw'), layoutId: 8 };
    const second = compatibilityRow('layout-1', 'h10p13', 'raw');
    const third = { ...compatibilityRow('layout-8-b', 'h10p14', 'raw'), layoutId: 8 };
    const partitioned = partitionLegacyFingerprintCompatibilityRows([first, second, third]);
    expect(partitioned.get(1)?.map((row) => row.uuid)).toEqual(['layout-1']);
    expect(partitioned.get(8)?.map((row) => row.uuid)).toEqual(['layout-8-a', 'layout-8-b']);
  });

  it.each(['raw', 'projected'] as const)(
    'matches an identical relight stored with a %s hash without owning the simple hash',
    (storedForm) => {
      const animated = compatibilityRow('animated', 'h10p12e1h10p14s2', storedForm);
      const animatedFingerprint = fingerprints('h10p12e1h10p14s2').raw;
      const simpleFingerprint = fingerprints('h10p12').raw;
      const owners = enrichFingerprintOwnersWithLegacyCompatibility(
        [{ uuid: animated.uuid, fingerprint: animated.fingerprint }],
        [animated],
      );
      expect(owners.get(animatedFingerprint)).toBe('animated');
      expect(owners.has(simpleFingerprint)).toBe(false);
    },
  );

  it.each(['raw', 'projected'] as const)(
    'matches an identical delayed start stored with a %s hash without owning the immediate hash',
    (storedForm) => {
      const delayed = compatibilityRow('delayed', 'h10p13s2', storedForm);
      const delayedFingerprint = fingerprints('h10p13s2').raw;
      const immediateFingerprint = fingerprints('h10p13').raw;
      const owners = enrichFingerprintOwnersWithLegacyCompatibility(
        [{ uuid: delayed.uuid, fingerprint: delayed.fingerprint }],
        [delayed],
      );
      expect(owners.get(delayedFingerprint)).toBe('delayed');
      expect(owners.has(immediateFingerprint)).toBe(false);
    },
  );

  it.each([
    ['animated-first', ['animated', 'simple']],
    ['simple-first', ['simple', 'animated']],
  ] as const)('re-elects the exact simple owner when UUID order is %s', (_label, order) => {
    const animated = compatibilityRow('animated', 'h10p12e1h10p14s2', 'projected');
    const simpleFingerprint = fingerprints('h10p12').raw;
    const rows = order.map((uuid) => ({
      uuid,
      fingerprint: uuid === 'animated' ? animated.fingerprint : simpleFingerprint,
    }));
    const owners = enrichFingerprintOwnersWithLegacyCompatibility(rows, [animated]);
    expect(owners.get(fingerprints('h10p12e1h10p14s2').raw)).toBe('animated');
    expect(owners.get(simpleFingerprint)).toBe('simple');
  });

  it('keeps unproven stored keys opaque and stable-first', () => {
    const unproven = { ...compatibilityRow('first', 'h10p12e1h10p14s2', 'raw'), fingerprint: 'unproven' };
    const owners = enrichFingerprintOwnersWithLegacyCompatibility(
      [
        { uuid: 'first', fingerprint: 'independent' },
        { uuid: 'second', fingerprint: 'independent' },
      ],
      [unproven],
    );
    expect(owners.get('independent')).toBe('first');
  });

  it('uses projected fingerprints only to broaden a matching reroute fetch', () => {
    const animated = compatibilityRow('animated', 'h10p12e1h10p14s2', 'projected');
    const animatedRaw = fingerprints('h10p12e1h10p14s2').raw;
    const simpleRaw = fingerprints('h10p12').raw;
    expect(storedFingerprintsForRawCandidates(new Set([animatedRaw]), [animated])).toEqual([
      animatedRaw,
      animated.fingerprint,
    ]);
    expect(storedFingerprintsForRawCandidates(new Set([simpleRaw]), [animated])).toEqual([simpleRaw]);
  });
});

describe('catalog fingerprint decision', () => {
  it('hashes raw events but returns only projected insertion rows', () => {
    const { decoded, raw } = fingerprints('h10p12e1h10p14s2');
    const decision = decideCatalogFingerprint(
      new Map(),
      'animated',
      decoded.fingerprintEvents,
      decoded.holdRowsToInsert,
    );
    expect(decision.fingerprint).toBe(raw);
    expect(decision.holdRowsToInsert).toEqual([{ holdId: 100, holdState: 'STARTING', frameNumber: 0 }]);
  });

  it('never dedups empty projections even when raw unknown-role events exist', () => {
    const first = decode('h10p999', 1);
    const second = decode('h10p999', 1);
    expect(first.fingerprintEvents).not.toEqual([]);
    expect(first.holdRowsToInsert).toEqual([]);
    const strandedEmptyOwner = new Map([[fingerprintFromHolds(first.fingerprintEvents), 'stranded']]);
    for (const [uuid, decoded] of [
      ['first-empty', first],
      ['second-empty', second],
    ] as const) {
      const decision = decideCatalogFingerprint(
        strandedEmptyOwner,
        uuid,
        decoded.fingerprintEvents,
        decoded.holdRowsToInsert,
      );
      expect(decision).toMatchObject({ fingerprint: null, canonicalUuid: uuid, canonicalToInsert: uuid });
      expect(decision.holdRowsToInsert).toEqual([]);
    }
  });
});
