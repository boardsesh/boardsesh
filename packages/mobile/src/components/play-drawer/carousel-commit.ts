/** A short intentional flick commits; opposing velocity and stationary taps do not. */
export function carouselCommitDirection(
  offset: number,
  velocity: number,
  threshold: number,
): 'next' | 'previous' | null {
  'worklet';
  const distanceCommit = Math.abs(offset) > threshold;
  const flickCommit = Math.abs(offset) >= 16 && Math.abs(velocity) >= 800 && Math.sign(offset) === Math.sign(velocity);
  if (!distanceCommit && !flickCommit) return null;
  return offset < 0 ? 'next' : 'previous';
}
