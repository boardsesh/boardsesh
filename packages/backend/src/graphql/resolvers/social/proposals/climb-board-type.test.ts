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
});
