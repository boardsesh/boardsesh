/** `#RRGGBB` with an alpha channel, for tints of a palette colour. */
export function withAlpha(hexColor: string, alpha: number): string {
  const clamped = Math.round(Math.min(1, Math.max(0, alpha)) * 255);
  return `${hexColor.slice(0, 7)}${clamped.toString(16).padStart(2, '0')}`;
}
