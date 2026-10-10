/** The authenticated server's account-creation result, never inferred from account age. */
export type AccountCreationReceipt = {
  userId: string;
  accountCreated: boolean;
  provider: 'email' | 'apple' | 'google';
  createdAt: string;
};

export function parseAccountCreationReceipt(candidate: unknown): AccountCreationReceipt | null {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null;
  const receipt = candidate as Record<string, unknown>;
  if (
    typeof receipt.userId !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(receipt.userId) ||
    typeof receipt.accountCreated !== 'boolean' ||
    !['email', 'apple', 'google'].includes(String(receipt.provider)) ||
    typeof receipt.createdAt !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(receipt.createdAt) ||
    !Number.isFinite(Date.parse(receipt.createdAt)) ||
    new Date(receipt.createdAt).toISOString() !== receipt.createdAt
  )
    return null;
  return {
    userId: receipt.userId,
    accountCreated: receipt.accountCreated,
    provider: receipt.provider as AccountCreationReceipt['provider'],
    createdAt: receipt.createdAt,
  };
}
