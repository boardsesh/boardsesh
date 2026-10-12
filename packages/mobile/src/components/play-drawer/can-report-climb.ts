// Who may report their OWN climb. You cannot usefully report a climb you set
// (#5960), except on a spray wall, where the report's grade proposal is how a
// setter changes their own climb's grade (#5971). The climb actions
// (`useClimbActions`) apply it, for the long-press menu and the player's ⋯ alike.

/** Can a climber report a climb they set on this board? Spray walls only. */
export function ownClimbIsReportable(boardName: string | null | undefined): boolean {
  return boardName === 'spray';
}
