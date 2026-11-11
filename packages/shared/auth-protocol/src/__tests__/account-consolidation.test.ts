import { describe, expect, it } from 'vite-plus/test';
import { parseAccountConsolidationReceipt } from '../account-consolidation';

describe('account consolidation receipt', () => {
  const receipt = { mergeId: 'merge', fromUserId: 'source', toUserId: 'target' };
  it('returns an isolated receipt matching both credential owners', () => {
    expect(parseAccountConsolidationReceipt(receipt, 'source', 'target')).toEqual(receipt);
    expect(parseAccountConsolidationReceipt(receipt, 'source', 'target')).not.toBe(receipt);
  });
  it.each([
    null,
    [],
    {},
    { ...receipt, mergeId: '' },
    { ...receipt, fromUserId: 'other' },
    { ...receipt, toUserId: 'source' },
    { ...receipt, mergeId: 'a\nb' },
  ])('refuses malformed or mismatched receipt %#', (candidate) => {
    expect(parseAccountConsolidationReceipt(candidate, 'source', 'target')).toBeNull();
  });
});
