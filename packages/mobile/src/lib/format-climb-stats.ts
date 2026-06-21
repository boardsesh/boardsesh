/** Format a count compactly: <1000 as-is, 1k–999k compact, ≥1m with decimal + m */
export function formatCount(count: number): string {
  if (count >= 1_000_000) {
    const millions = count / 1_000_000;
    const fixed = millions.toFixed(1);
    return `${fixed.endsWith('.0') ? fixed.slice(0, -2) : fixed}m`;
  }
  if (count < 1000) return `${count}`;
  const thousands = count / 1000;
  if (thousands < 10) {
    const fixed = thousands.toFixed(1);
    return `${fixed.endsWith('.0') ? fixed.slice(0, -2) : fixed}k`;
  }
  return `${Math.round(thousands)}k`;
}

/** Minimal translate signature so this pure util stays out of React.
 *  Resolves the `sends` plural key in the `climbs` namespace. */
export type TranslateSends = (key: string, options: { count: number; formattedCount: string }) => string;

/** Localized send count with compact number: t('sends') → "1.5k sends" / "1 send".
 *  Passes the true `count` for plural selection and `formattedCount` for display. */
export function formatSends(count: number, t: TranslateSends): string {
  return t('sends', { count, formattedCount: formatCount(count) });
}

/** Round quality_average to 1 decimal place */
export function formatQuality(quality: string): string {
  const n = parseFloat(quality);
  if (Number.isNaN(n)) return quality;
  return n.toFixed(1);
}
