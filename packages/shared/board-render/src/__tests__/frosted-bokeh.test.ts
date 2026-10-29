import { describe, expect, it } from 'vitest';
import { getOgBokehInput, renderFrostedBokehBuffer } from '../frosted-bokeh';
import type { WasmRenderConfig } from '../types';

function renderConfig(frames: string): WasmRenderConfig {
  return {
    board_name: 'kilter',
    board_width: 100,
    board_height: 120,
    output_width: 500,
    frames,
    mirrored: false,
    thumbnail: false,
    holds: [
      { id: 1, cx: 10, cy: 110, r: 5, mirroredHoldId: 2 },
      { id: 2, cx: 90, cy: 10, r: 5, mirroredHoldId: 1 },
    ],
    hold_state_map: { 12: { color: '#00DD00' }, 13: { color: '#4DF5FD' } },
  };
}

describe('getOgBokehInput', () => {
  it('uses the overlay geometry and selected screen colours for the effective first frame', () => {
    expect(getOgBokehInput(renderConfig('p1r13,p2r12'))).toEqual({
      points: [{ x: 10, y: 110, color: '#4DF5FD' }],
      source: { w: 100, h: 120 },
    });
  });

  it('mirrors positions using the same partner fallback as the foreground renderer', () => {
    expect(getOgBokehInput({ ...renderConfig('p1r12'), mirrored: true }).points).toEqual([
      { x: 90, y: 10, color: '#00DD00' },
    ]);
  });

  it('ignores missing holds and roles, and preserves Rust first-frame parsing', () => {
    expect(getOgBokehInput(renderConfig('p999r12p1r999')).points).toEqual([]);
    expect(getOgBokehInput(renderConfig('p1r12x1p2r13')).points).toEqual([{ x: 90, y: 10, color: '#4DF5FD' }]);
    expect(getOgBokehInput(renderConfig(',p1r12')).points).toEqual([]);
  });
});

describe('renderFrostedBokehBuffer', () => {
  const source = { w: 100, h: 100 };

  it('renders deterministic opaque RGBA even with no usable points', async () => {
    const first = await renderFrostedBokehBuffer({ points: [], source });
    const second = await renderFrostedBokehBuffer({ points: [], source });
    expect(first.equals(second)).toBe(true);
    expect(first.length).toBe(1200 * 630 * 4);
    expect(first[3]).toBe(255);
    expect(first[0]).toBeGreaterThan(14); // White frost over the near-black base.
  });

  it('paints the supplied role colours and protects the details column', async () => {
    const input = { points: [{ x: 50, y: 25, color: '#FF0000' }], source };
    const open = await renderFrostedBokehBuffer(input);
    const protectedCard = await renderFrostedBokehBuffer({ ...input, protectDetails: true });
    const center = (315 * 1200 + 900) * 4;
    expect(open[center]).toBeGreaterThan(open[center + 2] + 50);
    expect(protectedCard[center]).toBeLessThan(open[center]);
  });

  it('keeps arbitrary colour strings out of SVG markup', async () => {
    const rendered = await renderFrostedBokehBuffer({
      points: [{ x: 50, y: 50, color: '"><image href="https://example.com"/>' }],
      source,
    });
    expect(rendered.length).toBe(1200 * 630 * 4);
  });
});
