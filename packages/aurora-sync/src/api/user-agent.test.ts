import { describe, expect, it } from 'vitest';
import { AURORA_BOARDS, auroraUserAgent } from './types';

/**
 * Every Aurora request used to announce itself as "Kilter Board" no matter
 * which board it was talking to — copied from the login code and spread by
 * copy-paste across five call sites. Aurora does not validate it, so this is
 * hygiene rather than a functional fix: identifying as the wrong product to a
 * third party is wrong on its face, and the rest of this client deliberately
 * mirrors the official app.
 */
describe('auroraUserAgent', () => {
  it('names the board it is actually talking to', () => {
    expect(auroraUserAgent('tension')).toBe('Tension Board/202 CFNetwork/1568.100.1 Darwin/24.0.0');
    expect(auroraUserAgent('kilter')).toBe('Kilter Board/202 CFNetwork/1568.100.1 Darwin/24.0.0');
  });

  it('keeps So iLL capitalised the way the product is', () => {
    // Not derivable by capitalising the board key, which is the reason the map
    // is explicit rather than generated.
    expect(auroraUserAgent('soill').startsWith('So iLL Board/')).toBe(true);
  });

  it('covers every Aurora board', () => {
    // A new board added to AURORA_BOARDS without a name here would fall back to
    // `undefined/202 …` — worse than the bug being fixed.
    for (const board of AURORA_BOARDS) {
      expect(auroraUserAgent(board), `no app name for ${board}`).not.toContain('undefined');
    }
  });

  it('never sends Kilter for a non-Kilter board', () => {
    for (const board of AURORA_BOARDS.filter((candidate) => candidate !== 'kilter')) {
      expect(auroraUserAgent(board), `${board} still identifies as Kilter`).not.toContain('Kilter');
    }
  });
});
