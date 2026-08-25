/**
 * True when a board can have new climbs set on it from inside Boardsesh.
 *
 * Woods can't yet. The create-climb editor paints holds through
 * `getCreateBoardHolds`, whose `family` falls through to `'aurora'` for anything
 * that isn't MoonBoard — so a Woods draft would be saved with Aurora role codes
 * instead of the Woods wire roles (`p{loc}r{code}`, spec §6) the board's LEDs and
 * our own frames parser speak. It would also be published against a board with no
 * `board_placements` rows behind it, which the hold filters and the setter
 * surfaces both read.
 *
 * So the Create / Fork / Edit entry points are HIDDEN for Woods rather than left
 * to fail: browsing, lighting up and ticking the imported Woods catalog all work,
 * and setting your own Woods climbs is a follow-up.
 *
 * Every other board keeps creation exactly as it was.
 */
export function supportsClimbCreation(boardName: string | undefined): boolean {
  return boardName !== 'woods';
}
