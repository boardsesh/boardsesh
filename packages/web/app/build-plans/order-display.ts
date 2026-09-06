import type { CncCatalog, CncOrderStatus } from '@boardsesh/shared-schema';

/**
 * The two presentation decisions the orders list and the order page both make,
 * kept in one place so a status can never be green on one screen and grey on
 * the other.
 */

/** How each status reads at a glance. Not a colour, a verdict. */
export function orderStatusChipColor(status: CncOrderStatus): 'default' | 'info' | 'success' | 'error' | 'warning' {
  switch (status) {
    case 'ready':
      return 'success';
    case 'queued':
    case 'generating':
      return 'info';
    case 'failed':
      return 'error';
    // Refunded is a warning rather than an error: nothing broke, the download
    // is simply switched off. `cancelled` is a lapsed checkout, which is not a
    // problem at all — nobody was charged.
    case 'refunded':
      return 'warning';
    case 'pending_payment':
    case 'cancelled':
      return 'default';
  }
}

/**
 * The wall's catalogue label ("10x12"), or the raw size id when the catalogue
 * no longer carries that entry.
 *
 * A retired entry must not blank out an order somebody paid for — the licence
 * outlives the catalogue, and "25" is still enough for a buyer to recognise
 * their own wall.
 */
export function wallLabel(
  catalog: CncCatalog | null,
  order: { boardName: string; layoutId: number; sizeId: number },
): string {
  const entry = catalog?.entries.find(
    (candidate) =>
      candidate.boardName === order.boardName &&
      candidate.layoutId === order.layoutId &&
      candidate.sizeId === order.sizeId,
  );
  return entry?.label ?? String(order.sizeId);
}
