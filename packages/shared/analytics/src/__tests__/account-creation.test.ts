import { describe, expect, it } from 'vitest';
import { parseAccountCreationReceipt } from '../account-creation';

const receipt = {
  userId: '602c83bf-e090-4c90-9f7e-08ca0b6b5dad',
  accountCreated: true,
  provider: 'apple',
  createdAt: '2026-10-10T00:00:00.000Z',
};

describe('account creation receipts', () => {
  it('retains exact creation and returning-account results while dropping extra fields', () => {
    expect(parseAccountCreationReceipt({ ...receipt, token: 'never-copy' })).toEqual(receipt);
    expect(parseAccountCreationReceipt({ ...receipt, accountCreated: false })).toEqual({
      ...receipt,
      accountCreated: false,
    });
  });

  it.each([
    null,
    { ...receipt, userId: 'not-a-uuid' },
    { ...receipt, provider: 'facebook' },
    { ...receipt, accountCreated: 'true' },
    { ...receipt, createdAt: '2026-02-30T00:00:00.000Z' },
    { ...receipt, createdAt: 'yesterday' },
  ])('rejects malformed or unsupported receipts', (candidate) => {
    expect(parseAccountCreationReceipt(candidate)).toBeNull();
  });
});
