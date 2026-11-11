/** Use a side rail when bottom controls would compete with the photo's short axis. */
export function shouldUseSprayPhotoRail(
  width: number,
  height: number,
  photoWidth: number,
  photoHeight: number,
): boolean {
  if (width <= 0 || height <= 0) return false;
  return height < 480 || width >= height === photoWidth >= photoHeight;
}
