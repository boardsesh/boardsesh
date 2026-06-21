import { describe, expect, it } from 'vitest';
import {
  getMoonBoardLocationConfigs,
  resolveDefaultAuroraLocationConfig,
  resolveKilterInstallConfig,
  resolveSetIdsFromBitmask,
} from './config';
import { boardUuidForSource, gymUuidForSource, slugifyLocationName } from './ids';

describe('location sync config helpers', () => {
  it('preserves deterministic IDs and slugs used by the old location seed', () => {
    const sourceKey = 'moonboard:Basement Board:12.3:45.6';
    expect(boardUuidForSource(sourceKey)).toMatch(/^[0-9a-f-]{36}$/);
    expect(gymUuidForSource(sourceKey)).toMatch(/^[0-9a-f-]{36}$/);
    expect(slugifyLocationName('Basement Board - MoonBoard', boardUuidForSource(sourceKey))).toMatch(
      /^basement-board-moonboard-[0-9a-f]{8}$/,
    );
  });

  it('resolves set IDs from Kilter accumulated hold-set bitmasks', () => {
    expect(resolveSetIdsFromBitmask('kilter', 8, 25, 0)).toBe('26,27,28,29');
    expect(resolveSetIdsFromBitmask('kilter', 8, 25, 1)).toBe('26');
    expect(resolveSetIdsFromBitmask('kilter', 8, 25, 5)).toBe('26,28');
  });

  it('resolves Kilter wall config by product-layout edges', () => {
    const config = resolveKilterInstallConfig({
      layoutId: 1,
      productLayoutUuid: null,
      productLayoutEdges: {
        edgeLeft: 0,
        edgeRight: 144,
        edgeBottom: 0,
        edgeTop: 180,
      },
      accumulatedHoldSetValue: 0,
      angle: null,
      isAngleAdjustable: true,
    });

    expect(config).toMatchObject({
      boardType: 'kilter',
      layoutId: 1,
      sizeId: 7,
      setIds: '1,20',
      angle: 40,
      isAngleAdjustable: true,
    });
  });

  it('prefers valid Kilter product-layout UUID size IDs before matching edges', () => {
    const config = resolveKilterInstallConfig({
      layoutId: 8,
      productLayoutUuid: '26',
      productLayoutEdges: {
        edgeLeft: -56,
        edgeRight: 56,
        edgeBottom: -12,
        edgeTop: 144,
      },
      accumulatedHoldSetValue: 0,
      angle: 40,
      isAngleAdjustable: true,
    });

    expect(config).toMatchObject({
      boardType: 'kilter',
      layoutId: 8,
      sizeId: 26,
      setIds: '26,28,29',
    });
  });

  it('uses the existing Tension default for Aurora pin-only locations', () => {
    expect(resolveDefaultAuroraLocationConfig('tension')).toEqual({
      boardType: 'tension',
      layoutId: 10,
      sizeId: 6,
      setIds: '12,13',
      angle: 40,
      isAngleAdjustable: true,
    });
  });

  it('creates every MoonBoard layout and angle config', () => {
    const configs = getMoonBoardLocationConfigs();
    expect(configs).toHaveLength(12);
    expect(configs.map((config) => `${config.layoutId}:${config.angle}`)).toContain('2:25');
    expect(configs.map((config) => `${config.layoutId}:${config.angle}`)).toContain('2:40');
    expect(configs.every((config) => config.sizeId === 1)).toBe(true);
  });
});
