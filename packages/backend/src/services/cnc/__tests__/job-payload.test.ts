import { describe, expect, it } from 'vite-plus/test';
import type { CncOrder } from '@boardsesh/db/schema';
import { buildWorkerJob } from '../job-payload';
import { computeCncConfigHash } from '../config-hash';

/** Only persisted fields read by the pure job mapper are needed here. */
function savedOrder(mode: string, standard: string): CncOrder {
  return {
    id: 1042,
    userId: 'buyer',
    licenceId: 'BS-CNC-TEST23',
    claimToken: 'claim',
    generation: 1,
    attempts: 1,
    status: 'generating',
    tier: 'personal',
    licenseeName: 'Home climber',
    licenseeEmail: 'buyer@example.com',
    customerSiteName: null,
    boardName: 'tension',
    layoutId: mode === 'spray' ? 11 : 10,
    sizeId: 10,
    setIds: mode === 'spray' ? '12,13' : '12,13,14,15',
    options: {
      tb2DimensionStandard: standard,
      tb2Engraving: mode,
      sheetStock: '3600x1220',
      supportStrips: false,
      dxfFlavour: 'R12_circles',
      paper: 'A3',
    },
    artwork: [],
    catalogVersion: 'saved-catalogue-version',
  } as unknown as CncOrder;
}

const context = { bucket: 'test-packs', issuedAt: new Date('2026-09-07T00:00:00Z') };

describe('saved TB2 orders', () => {
  it.each(['none', 'mirror', 'spray', 'both'])('regenerates %s from saved choices', (mode) => {
    for (const standard of ['metric', 'imperial']) {
      const order = savedOrder(mode, standard);
      const job = buildWorkerJob(order, context);
      expect(job.catalogVersion).toBe('saved-catalogue-version');
      expect(job.output.engrave).toEqual({ layoutMode: mode, holdIds: false, angleTicks: false });
      expect(job.layoutRequest.manufacturing).toEqual({
        dimension_standard: standard,
        sheet: { length_mm: 3600, width_mm: 1220 },
        support_strips: false,
      });
      expect(job.config.options).toEqual(order.options);
      expect(buildWorkerJob({ ...order, generation: 2 }, context).layoutRequest).toEqual(job.layoutRequest);
      expect(buildWorkerJob({ ...order, status: 'preview_generating' }, context).output).toEqual(job.output);
    }
  });

  it('gives every engraving and dimension combination a different preview identity', () => {
    const hashes = ['none', 'mirror', 'spray', 'both'].flatMap((mode) =>
      ['metric', 'imperial'].map((standard) => computeCncConfigHash(savedOrder(mode, standard))),
    );
    expect(new Set(hashes).size).toBe(8);
  });
});
