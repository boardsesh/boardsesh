import { describe, expect, it } from 'vite-plus/test';
import { assertClimbBoardType } from './climb-board-type';

describe('assertClimbBoardType', () => {
  it('accepts the stored board type', () => {
    expect(() => assertClimbBoardType('grasshopper', 'grasshopper')).not.toThrow();
  });

  it('rejects a client-declared Grasshopper scope for a Kilter climb', () => {
    expect(() => assertClimbBoardType('kilter', 'grasshopper')).toThrowError(
      expect.objectContaining({ extensions: { code: 'BAD_USER_INPUT' } }),
    );
  });

  // The rule is symmetric today only because it is plain equality. Pinning the
  // reverse direction keeps it that way: an allowlist that later let one board
  // stand in for another would break in a single direction, and a one-way test
  // would stay green straight through it.
  it('rejects the mismatch in the other direction too', () => {
    expect(() => assertClimbBoardType('grasshopper', 'kilter')).toThrowError(
      expect.objectContaining({ extensions: { code: 'BAD_USER_INPUT' } }),
    );
  });
});
