import { describe, expect, it } from 'vite-plus/test';
import { drizzle } from 'drizzle-orm/postgres-js';
import {
  legacyAuroraRawFrameHoldEvents,
  projectAuroraFramesToStoredRows,
} from '@boardsesh/board-constants/hold-states';

import {
  enrichFingerprintOwnersWithLegacyCompatibility,
  indexStoredFingerprintOwners,
} from './catalog-fingerprint-compat';
import { fingerprintFromHolds } from './fingerprint';
import { existingCatalogLayoutRowsQuery } from './catalog-sync';

const renderOnlyDb = drizzle({} as never);

describe('catalog fingerprint owner ordering', () => {
  it('orders the existing-layout query by raw UUID before first-owner indexing', () => {
    const rendered = existingCatalogLayoutRowsQuery(renderOnlyDb, 42).toSQL();
    const normalizedSql = rendered.sql.replaceAll(/\s+/g, ' ').trim().toLowerCase();

    expect(normalizedSql).toContain('order by "board_climbs"."uuid"');
    expect(normalizedSql).not.toContain('lower("board_climbs"."uuid")');
    expect(rendered.params).toEqual(['kilter', 42]);
  });

  it('routes duplicate legacy owners to the stable first UUID', () => {
    const frames = 'p100r12,"x100p100r13';
    const legacyFingerprint = fingerprintFromHolds(legacyAuroraRawFrameHoldEvents(frames, 'kilter'));
    const orderedExistingRows = [
      { uuid: 'a-stable-owner', fingerprint: legacyFingerprint },
      { uuid: 'z-secondary-owner', fingerprint: legacyFingerprint },
    ];
    const storedFingerprintOwners = indexStoredFingerprintOwners(orderedExistingRows);

    const compatibilityRows = orderedExistingRows.map((row) => ({
      layoutId: 42,
      uuid: row.uuid,
      frames,
      fingerprint: row.fingerprint,
    }));
    const enriched = enrichFingerprintOwnersWithLegacyCompatibility(storedFingerprintOwners, compatibilityRows);
    const projectedFingerprint = fingerprintFromHolds(projectAuroraFramesToStoredRows(frames, 'kilter').rows);

    expect(storedFingerprintOwners.get(legacyFingerprint)).toBe('a-stable-owner');
    expect(enriched.get(projectedFingerprint)).toBe('a-stable-owner');
  });
});
