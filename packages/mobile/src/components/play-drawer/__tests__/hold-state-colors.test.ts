import { describe, expect, it } from 'vitest';
import { holdStateColors, roleStateInfo } from '../hold-state-colors';

// The glow and Active holds take a role's colour from one place (#7000).
describe('holdStateColors', () => {
  it('gives every role on the board a colour', () => {
    const colours = holdStateColors('kilter', 'classic', {});
    for (const role of ['STARTING', 'HAND', 'FINISH', 'FOOT']) expect(colours.get(role)).toMatch(/^#/);
  });

  it("carries the climber's colour overrides", () => {
    expect(holdStateColors('kilter', 'classic', { HAND: '#123456' }).get('HAND')).toBe('#123456');
  });

  it('follows the board render mode, as the board does', () => {
    let boardsThatDiffer = 0;
    for (const board of ['kilter', 'tension', 'moonboard'] as const) {
      const classic = [...holdStateColors(board, 'classic', {}).values()];
      const aura = [...holdStateColors(board, 'aura', {}).values()];
      boardsThatDiffer += classic.join() === aura.join() ? 0 : 1;
    }
    expect(boardsThatDiffer).toBeGreaterThan(0);
  });

  it('finds a role by its canonical code', () => {
    expect(roleStateInfo('kilter', 'FINISH')?.name).toBe('FINISH');
    expect(roleStateInfo('kilter', 'NOT_A_ROLE')).toBeUndefined();
  });
});
