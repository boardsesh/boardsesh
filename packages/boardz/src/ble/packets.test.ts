import { describe, expect, it } from 'vitest';
import { getBoardLayouts, getDefaultBoardSizeForLayout } from '@boardsesh/board-config';
import { getLedPlacements } from '@boardsesh/board-constants/led-placements';
import { WOODS_LED_MAPS } from '@boardsesh/board-constants/woods';
import { buildBoardPacket } from './packets';

const decode = (packet: Uint8Array) => new TextDecoder().decode(packet);

describe('buildBoardPacket', () => {
  const moonboard2016 = { boardName: 'moonboard' as const, layoutId: 2, sizeId: 1 };
  const miniMoonboard2020 = { boardName: 'moonboard' as const, layoutId: 6, sizeId: 1 };

  it('encodes MoonBoard holds on the 18-row serpentine LED strip', () => {
    // Hold 1 = A1 (start), hold 45 = A5 (hand), hold 198 = K18 (finish).
    const result = buildBoardPacket(moonboard2016, 'p1r42p45r43p198r44', 'MoonBoard A');
    expect(result.kind).toBe('packet');
    if (result.kind === 'packet') expect(decode(result.packet)).toBe('l#S0,P4,E197#');
  });

  it('addresses the Mini MoonBoard on its 12-row strip', () => {
    // Hold 12 = A2 on the 11-column grid: column A, second row up.
    const result = buildBoardPacket(miniMoonboard2020, 'p12r42', 'MoonBoard Mini');
    expect(result.kind).toBe('packet');
    if (result.kind === 'packet') expect(decode(result.packet)).toBe('l#S1#');
  });

  it('sends the MoonBoard clear-all frame for empty frames', () => {
    const result = buildBoardPacket(moonboard2016, '', null);
    expect(result.kind).toBe('packet');
    if (result.kind === 'packet') expect(decode(result.packet)).toBe('l##');
  });

  it('refuses a MoonBoard climb with no usable holds instead of darkening the board', () => {
    expect(buildBoardPacket(moonboard2016, 'p999r42', null)).toEqual({ kind: 'incompatible' });
  });

  it('encodes a Woods climb as LED and role pairs, ended by ,!', () => {
    const woods = { boardName: 'woods' as const, layoutId: 1, sizeId: 1 };
    const [location, led] = Object.entries(WOODS_LED_MAPS['8x10'])[0];
    // Role 4 is a Woods start hold.
    const result = buildBoardPacket(woods, `p${location}r4`, 'Woods Board');
    expect(result.kind).toBe('packet');
    if (result.kind === 'packet') expect(decode(result.packet)).toBe(`${led},4,!`);
  });

  it('clears a Woods board with a bare ,! and refuses holds it does not have', () => {
    const woods = { boardName: 'woods' as const, layoutId: 1, sizeId: 1 };
    const clear = buildBoardPacket(woods, '', null);
    expect(clear.kind === 'packet' && decode(clear.packet)).toBe(',!');
    expect(buildBoardPacket(woods, 'p99999r4', null)).toEqual({ kind: 'incompatible' });
    expect(buildBoardPacket({ ...woods, sizeId: 9 }, 'p1r4', null)).toEqual({ kind: 'incompatible' });
  });

  it('encodes a Tension climb through the LED placement map', () => {
    const [layout] = getBoardLayouts('tension');
    const sizeId = getDefaultBoardSizeForLayout('tension', layout.id);
    expect(sizeId).not.toBeNull();
    const board = { boardName: 'tension' as const, layoutId: layout.id, sizeId: sizeId ?? 0 };
    const [placementId] = Object.keys(getLedPlacements('tension', board.layoutId, board.sizeId));
    expect(placementId).toBeDefined();

    // Role 1 is a Tension start hold.
    const result = buildBoardPacket(board, `p${placementId}r1`, 'Tension Board#12345@3');
    expect(result.kind).toBe('packet');
    if (result.kind === 'packet') expect(result.packet.length).toBeGreaterThan(0);
  });

  it('refuses a Tension climb whose holds are not on this board', () => {
    const [layout] = getBoardLayouts('tension');
    const sizeId = getDefaultBoardSizeForLayout('tension', layout.id) ?? 0;
    const board = { boardName: 'tension' as const, layoutId: layout.id, sizeId };
    expect(buildBoardPacket(board, 'p999999r1', null)).toEqual({ kind: 'incompatible' });
  });
});
