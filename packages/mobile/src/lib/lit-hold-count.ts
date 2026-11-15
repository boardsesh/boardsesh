/** Number of lit hold entries in a climb's frame string. */
export function countLitHolds(frames: string): number {
  return frames.match(/p\d+/g)?.length ?? 0;
}
