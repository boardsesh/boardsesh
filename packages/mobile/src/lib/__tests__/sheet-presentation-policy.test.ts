import { describe, expect, it } from 'vitest';
import {
  resolveSheetSurfaceBounds,
  resolveWebSheetPresentation,
  type OpeningInput,
} from '../sheet-presentation-policy';

describe('web sheet presentation policy', () => {
  it.each<OpeningInput>(['mouse', 'keyboard'])(
    'uses a wide dialog for %s but keeps compact windows as sheets',
    (openingInput) => {
      expect(resolveWebSheetPresentation({ width: 699, openingInput })).toBe('sheet');
      expect(resolveWebSheetPresentation({ width: 700, openingInput })).toBe('dialog');
    },
  );
  it.each<OpeningInput>(['touch', 'pen', 'unknown'])(
    'keeps %s openings bottom-docked on wide windows',
    (openingInput) => {
      expect(resolveWebSheetPresentation({ width: 1440, openingInput })).toBe('sheet');
    },
  );
  it('caps actual touch surfaces while keeping compact width', () => {
    expect(resolveSheetSurfaceBounds({ width: 699, height: 900, mode: 'sheet' }).width).toBe(699);
    expect(resolveSheetSurfaceBounds({ width: 700, height: 900, mode: 'sheet' }).width).toBe(640);
    expect(resolveSheetSurfaceBounds({ width: 1440, height: 900, mode: 'sheet' }).width).toBe(640);
  });
  it('caps form and list dialogs and adapts an open dialog to a smaller window', () => {
    expect(resolveSheetSurfaceBounds({ width: 1440, height: 900, mode: 'dialog' })).toEqual({
      width: 560,
      height: 720,
    });
    expect(resolveSheetSurfaceBounds({ width: 1440, height: 900, mode: 'dialog', surfaceSize: 'list' }).width).toBe(
      672,
    );
    expect(resolveSheetSurfaceBounds({ width: 390, height: 300, mode: 'dialog' })).toEqual({ width: 342, height: 252 });
    expect(resolveSheetSurfaceBounds({ width: 20, height: 20, mode: 'dialog' })).toEqual({ width: 0, height: 0 });
  });
});
