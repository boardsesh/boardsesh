/**
 * "top 5%" from a percentile of 95, rounded the way boardsesh.com shows it
 * (one decimal from the 99th up). Null for 0, which the backend returns for a
 * climber it hasn't ranked yet.
 */
export function topShare(percentile: number): string | null {
  if (!(percentile > 0)) return null;
  return `top ${Math.max(0.1, 100 - percentile).toFixed(percentile >= 99 ? 1 : 0)}%`;
}
