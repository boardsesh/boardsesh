/**
 * Sortable rank for a grade label so chart X-axes read easy to hard. The font
 * token drives ordering: it is the finest-grained, `+`-aware key and is always
 * present in the backend's combined `"<font>/V<n>"` strings (e.g. "6a/V3",
 * "6a+/V3"). Reading only the V-number tied "6a/V3" and "6a+/V3" (both → 3), so
 * adjacent `+` grades landed in backend order. We now sort on the font token,
 * fall back to the V-number for V-only labels, and sort unknown labels last.
 */
export function gradeSortValue(gradeLabel: string): number {
  const fontMatch = gradeLabel.match(/(\d)([abc])(\+?)/i);
  if (fontMatch) {
    const number = Number(fontMatch[1]);
    const letter = fontMatch[2].toLowerCase().charCodeAt(0) - 96;
    return 100 + number * 10 + letter * 2 + (fontMatch[3] ? 1 : 0);
  }
  const vMatch = gradeLabel.match(/V(\d+)/i);
  if (vMatch) return Number(vMatch[1]);
  return Number.MAX_SAFE_INTEGER;
}
