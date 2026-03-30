/**
 * Convert Aurora/Kilter quality (1-3) to Boardsesh quality (1-5)
 */
export function convertQuality(quality: number | null | undefined): number | null {
  if (quality == null) return null;
  return Math.round((quality / 3.0) * 5);
}
