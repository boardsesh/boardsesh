import { describe, expect, it } from 'vite-plus/test';
import { parseArgs } from '../scripts/export-board-snapshots';

describe('board snapshot export --layout filter', () => {
  it('preserves safe integer layout filters in both flag forms', () => {
    expect(parseArgs(['--layout', '12']).layoutFilter).toBe(12);
    expect(parseArgs(['--layout=34']).layoutFilter).toBe(34);
  });

  it.each(['1000000000000000000', '9007199254740993'])('rejects unsafe layout id %s', (raw) => {
    expect(() => parseArgs(['--layout', raw])).toThrow('--layout expects a safe integer layout id');
  });
});
