import type { CncCatalog, CncLicenceTier, CncOrderStatus } from '@boardsesh/shared-schema';

/**
 * The presentation decisions the orders list, the order page and the admin
 * queue all make, kept in one place so one order can never read differently on
 * two screens somebody is looking at side by side.
 *
 * Status colour is deliberately NOT here: `StatusChip` in `./ui` owns the
 * status-to-tone mapping for all eleven states, including the four free-preview
 * ones. A second mapping onto MUI `Chip` colours is what let `preview_ready`
 * and `ready` look alike.
 */

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

/**
 * What licence an order carries — or "Preview" for one that has not been bought.
 *
 * `tier` is null for the whole free half of the lifecycle, so the old
 * `tier === 'personal' ? … : …` ternary quietly labelled every free preview
 * "Commercial, single build". Translation is injected rather than looked up
 * here so the same function serves a server component (`getServerTranslation`)
 * and a client one (`useTranslation`).
 *
 * The keep marker is because the translator arrives as a parameter: the orphan
 * scanner attributes keys to a `t` it can see bound to a namespace, and there
 * is no such binding in a plain helper module.
 *
 * i18n-keep cnc:orders.previewTier
 */
export function tierLabel(tier: CncLicenceTier | null, translate: (key: string) => string): string {
  if (tier === null) return translate('orders.previewTier');
  if (tier === 'personal') return translate('tiers.personal.name');
  return translate('tiers.commercial.name');
}

/**
 * What one watermarked sheet is called, from the object key the worker wrote.
 *
 * The generator names them `panel1.png` … `assembly.png`, which is a filename,
 * not a caption. Anything it starts naming differently falls back to the bare
 * basename rather than disappearing — a sheet with an odd name still has to be
 * captioned.
 *
 * i18n-keep cnc:order.preview.panel
 * i18n-keep cnc:order.preview.assembly
 */
export function previewImageLabel(
  name: string,
  translate: (key: string, options?: Record<string, unknown>) => string,
): string {
  const base = name.replace(/\.[a-z0-9]+$/i, '');
  const panel = /^panel(\d+)$/i.exec(base);
  if (panel) return translate('order.preview.panel', { number: Number(panel[1]) });
  if (base.toLowerCase() === 'assembly') return translate('order.preview.assembly');
  return base;
}

/** The free half of the lifecycle: no money has moved and none is owed. */
const PREVIEW_STATUSES: ReadonlySet<CncOrderStatus> = new Set<CncOrderStatus>([
  'preview_queued',
  'preview_generating',
  'preview_ready',
  'preview_failed',
]);

export function isPreviewStatus(status: CncOrderStatus): boolean {
  return PREVIEW_STATUSES.has(status);
}

/**
 * The one row on the orders list that gets the accent rule and the Finalise
 * link: the most recently previewed order that is still waiting to be bought.
 *
 * Only one, and only the newest — a buyer who previewed the same wall four
 * times wants to finalise the last one, and a list where every second row
 * shouts is a list where nothing does. `null` when nothing is waiting.
 *
 * Ordered by `createdAt` rather than by position, because "newest first" is the
 * server's promise and this decision is too load-bearing to inherit it.
 */
export function newestPreviewReadyLicenceId(
  orders: readonly { licenceId: string; status: CncOrderStatus; createdAt: string }[],
): string | null {
  let newest: { licenceId: string; createdAt: number } | null = null;
  for (const order of orders) {
    if (order.status !== 'preview_ready') continue;
    const createdAt = new Date(order.createdAt).getTime();
    if (Number.isNaN(createdAt)) continue;
    if (!newest || createdAt > newest.createdAt) {
      newest = { licenceId: order.licenceId, createdAt };
    }
  }
  return newest?.licenceId ?? null;
}

/**
 * Where the configurator picks a previewed order back up.
 *
 * The configurator reads `?order=` and resumes that preview, so "Finalise" from
 * the list and "Finalise" from the order page land on the same screen with the
 * same wall already loaded.
 */
export function finaliseHref(licenceId: string): string {
  return `/build-plans?order=${encodeURIComponent(licenceId)}`;
}
