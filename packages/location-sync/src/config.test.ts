import { describe, expect, it } from 'vitest';
import {
  getMoonBoardLocationConfigs,
  resolveAuroraWallConfig,
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

  describe('resolveAuroraWallConfig', () => {
    // The gatekeeper for "reject an unknown config instead of coercing it",
    // which is the whole reason gym walls are read from Aurora rather than
    // guessed. Tested directly because a silent coercion here would republish
    // exactly the wrong-layout boards this replaces.
    const SPRAY_WALL = {
      boardType: 'tension' as const,
      layoutId: 11,
      productSizeId: 6,
      setIds: [12, 13],
      angle: 40,
      isAngleAdjustable: true,
    };

    it('accepts a wall the catalogue recognises', () => {
      expect(resolveAuroraWallConfig(SPRAY_WALL)).toEqual({
        boardType: 'tension',
        layoutId: 11,
        sizeId: 6,
        setIds: '12,13',
        angle: 40,
        isAngleAdjustable: true,
      });
    });

    it('rejects an unknown layout', () => {
      expect(resolveAuroraWallConfig({ ...SPRAY_WALL, layoutId: 4242 })).toBeNull();
    });

    it('rejects a size that does not belong to the layout', () => {
      expect(resolveAuroraWallConfig({ ...SPRAY_WALL, productSizeId: 4242 })).toBeNull();
    });

    it('rejects hold sets that do not belong to the layout and size', () => {
      expect(resolveAuroraWallConfig({ ...SPRAY_WALL, setIds: [999] })).toBeNull();
      // A partly-valid list is still a wall we cannot render faithfully.
      expect(resolveAuroraWallConfig({ ...SPRAY_WALL, setIds: [12, 999] })).toBeNull();
    });

    it('rejects a wall listing no hold sets', () => {
      expect(resolveAuroraWallConfig({ ...SPRAY_WALL, setIds: [] })).toBeNull();
    });

    it('normalises set ids and drops duplicates', () => {
      expect(resolveAuroraWallConfig({ ...SPRAY_WALL, setIds: [13, 12, 13] })?.setIds).toBe('12,13');
    });

    it('falls back to the default angle for a wall reporting none', () => {
      // Aurora sends 0 for a fixed wall as often as a real angle, so only a
      // positive value counts as a measurement.
      expect(resolveAuroraWallConfig({ ...SPRAY_WALL, angle: 0 })?.angle).toBe(40);
      expect(resolveAuroraWallConfig({ ...SPRAY_WALL, angle: null })?.angle).toBe(40);
    });

    it('keeps a real reported angle and adjustability', () => {
      expect(resolveAuroraWallConfig({ ...SPRAY_WALL, angle: 25, isAngleAdjustable: false })).toMatchObject({
        angle: 25,
        isAngleAdjustable: false,
      });
    });

    it('distinguishes the Mirror and Spray layouts', () => {
      // The Benchmark Climbing bug in one line: layout 10 is Mirror, 11 is
      // Spray, and the old hardcoded default could only ever produce 10.
      expect(resolveAuroraWallConfig({ ...SPRAY_WALL, layoutId: 10 })?.layoutId).toBe(10);
      expect(resolveAuroraWallConfig(SPRAY_WALL)?.layoutId).toBe(11);
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
    expect(configs).toHaveLength(14);
    expect(configs.map((config) => `${config.layoutId}:${config.angle}`)).toContain('2:25');
    expect(configs.map((config) => `${config.layoutId}:${config.angle}`)).toContain('2:40');
    expect(configs.map((config) => `${config.layoutId}:${config.angle}`)).toContain('7:40');
    expect(configs.every((config) => config.sizeId === 1)).toBe(true);
  });
});
