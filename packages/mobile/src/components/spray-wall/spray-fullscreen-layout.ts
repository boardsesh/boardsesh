/** Use a side rail when bottom controls would compete with the photo's short axis. */
export function shouldUseSprayPhotoRail(
  width: number,
  height: number,
  photoWidth: number,
  photoHeight: number,
  bottomToolsHeight = 112,
): boolean {
  if (width <= 0 || height <= 0) return false;
  if (width >= height) return true;
  const fittedHeight = Math.min(height, (width * photoHeight) / photoWidth);
  return (height - fittedHeight) / 2 < bottomToolsHeight;
}
