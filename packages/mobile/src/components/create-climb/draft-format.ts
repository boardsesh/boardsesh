// Formatting helpers for the Open Drafts list, shared by the inline drafts
// section in the create drawer (and any other draft list surface).
// Relative-time formatting moved to src/lib/format-relative-time.ts.

// Count painted holds in an Aurora frames string (`p{id}r{code}` per hold).
export function countHolds(frames: string | null | undefined): number {
  const matches = frames?.match(/p\d+r\d+/g);
  return matches ? matches.length : 0;
}
