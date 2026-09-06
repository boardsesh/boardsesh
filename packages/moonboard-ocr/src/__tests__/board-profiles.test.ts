import { describe, expect, it } from 'vite-plus/test';
import { BOARD_PROFILES, boardRows, GRID_POSITIONS_BY_ROWS, type HoldSetup } from '../board-profiles';
import { GRID_POSITIONS } from '../types';
import { calculateAndroidRegions } from '../core/regions';
import { classifyPixelColor, detectHoldsFromPixelData, findNearestGridPosition } from '../core/holds';
import { parseWithProcessor } from '../parser-core';
import type { ImageProcessor } from '../image-processor/types';

describe('explicit MoonBoard setup geometry', () => {
  it('preserves every legacy full-size coordinate center', () => {
    expect(GRID_POSITIONS_BY_ROWS[18]).toEqual(GRID_POSITIONS);
  });

  it.each(Object.entries(BOARD_PROFILES))('maps every coordinate of setup %s', (id, profile) => {
    const rows = boardRows(Number(id) as HoldSetup);
    expect(rows).toBe(profile.rows);
    expect(Object.keys(GRID_POSITIONS_BY_ROWS[rows])).toHaveLength(11 * rows);
    for (const [coordinate, position] of Object.entries(GRID_POSITIONS_BY_ROWS[rows])) {
      expect(findNearestGridPosition(position.x, position.y, rows)).toEqual({ coordinate, distance: 0 });
    }
  });

  it.each([19, 22] as const)(
    'detects Mini setup %s bottom, middle and top roles without inventing rows 13–18',
    (id) => {
      const width = 660;
      const height = 720;
      const data = new Uint8Array(width * height * 4).fill(255);
      const rings = [
        { x: 90, y: 90, color: [255, 0, 0], coordinate: 'B11', role: 'finish' },
        { x: 330, y: 390, color: [0, 102, 255], coordinate: 'F6', role: 'hand' },
        { x: 510, y: 630, color: [0, 255, 0], coordinate: 'I2', role: 'start' },
      ];
      for (const ring of rings) {
        for (let y = ring.y - 27; y <= ring.y + 27; y++) {
          for (let x = ring.x - 27; x <= ring.x + 27; x++) {
            const radius = Math.hypot(x - ring.x, y - ring.y);
            if (radius >= 21 && radius <= 27) data.set(ring.color, (y * width + x) * 4);
          }
        }
      }
      // Red plastic on Masters 2017 falls inside the legacy iOS marker palette.
      // It must not manufacture a finish hold in the explicit Android profile.
      for (let y = 185; y <= 235; y++) {
        for (let x = 185; x <= 235; x++) {
          if (Math.hypot(x - 210, y - 210) <= 25) data.set([225, 82, 64], (y * width + x) * 4);
        }
      }
      const holds = detectHoldsFromPixelData(
        { data, width, height, channels: 4 },
        { x: 0, y: 0, width, height },
        boardRows(id),
        'android',
      );
      expect(holds.map((h) => [h.coordinate, h.type])).toEqual(rings.map((r) => [r.coordinate, r.role]));
    },
  );

  it('rejects unknown upstream IDs and unvalidated Android dimensions', () => {
    expect(() => boardRows(7 as HoldSetup)).toThrow('Unsupported');
    expect(() => calculateAndroidRegions(1008, 2240, 12)).toThrow('Unvalidated');
    expect(() => calculateAndroidRegions(2244, 1008, 18)).toThrow('Unvalidated');
  });

  it('keeps compressed Android ring reds while rejecting the legacy plastic-red range', () => {
    expect(classifyPixelColor(230, 0, 0, 'android')).toBe('finish');
    expect(classifyPixelColor(243, 1, 5, 'android')).toBe('finish');
    expect(classifyPixelColor(225, 82, 64, 'android')).toBeNull();
    expect(classifyPixelColor(244, 67, 54, 'android')).toBeNull();
    expect(classifyPixelColor(244, 67, 54)).toBe('finish');
    expect(classifyPixelColor(0, 240, 5, 'android')).toBe('start');
    expect(classifyPixelColor(0, 102, 255, 'android')).toBe('hand');
  });

  it('does not silently apply the legacy 18-row crop to a Mini screenshot', async () => {
    const processor = { getMetadata: () => ({ width: 1008, height: 2244 }) } as ImageProcessor;
    const result = await parseWithProcessor(processor, { holdsetup: 19 });
    expect(result.success).toBe(false);
    expect(result.error).toContain('Mini screenshots require');
  });

  it.each([23, 1, 15, 17] as const)('rejects unvalidated legacy iOS colors for setup %s', async (holdsetup) => {
    const processor = { getMetadata: () => ({ width: 1008, height: 2244 }) } as ImageProcessor;
    const result = await parseWithProcessor(processor, { holdsetup, screenshotProfile: 'legacy-ios' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('requires a validated Android screenshot profile');
  });

  it('uses a shorter, vertically centered Mini grid with the same cell spacing', () => {
    const full = calculateAndroidRegions(1008, 2244, 18).board;
    const mini = calculateAndroidRegions(1008, 2244, 12).board;
    expect(mini.x).toBe(full.x);
    expect(mini.width).toBe(full.width);
    expect(Math.abs(mini.height / 12 - full.height / 18)).toBeLessThan(0.1);
    expect(mini.y).toBeGreaterThan(full.y);
    expect(mini.y + mini.height).toBeLessThan(full.y + full.height);
  });
});
