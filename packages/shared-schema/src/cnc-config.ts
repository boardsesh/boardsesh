/** Map a catalogue engraving choice to its canonical TB2 board layout. */
export function tb2LayoutIdForEngraving(engraving: string): 10 | 11 {
  return engraving === 'spray' ? 11 : 10;
}
