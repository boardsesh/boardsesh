/** Optional refresh/session metadata. Never use a receipt as authentication. */
export interface AccountConsolidationReceipt {
  readonly mergeId: string;
  readonly fromUserId: string;
  readonly toUserId: string;
}

function identifier(candidate: unknown): candidate is string {
  return (
    typeof candidate === 'string' &&
    candidate.length > 0 &&
    candidate.length <= 4096 &&
    candidate === candidate.trim() &&
    !/\p{Cc}/u.test(candidate)
  );
}

/** Compare an authenticated response with both captured credential owners before changing local ownership. */
export function parseAccountConsolidationReceipt(
  candidate: unknown,
  expectedFromUserId: string,
  expectedToUserId: string,
): AccountConsolidationReceipt | null {
  if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) return null;
  const receipt = candidate as Record<string, unknown>;
  if (
    !identifier(receipt.mergeId) ||
    !identifier(receipt.fromUserId) ||
    !identifier(receipt.toUserId) ||
    receipt.fromUserId === receipt.toUserId ||
    receipt.fromUserId !== expectedFromUserId ||
    receipt.toUserId !== expectedToUserId
  )
    return null;
  return { mergeId: receipt.mergeId, fromUserId: receipt.fromUserId, toUserId: receipt.toUserId };
}
