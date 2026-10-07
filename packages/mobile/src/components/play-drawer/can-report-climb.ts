// Whether the play drawer offers "Report climb" for the climb on display. A draft
// is visible to its setter alone, and you cannot usefully report your own climb
// (#5960). A spray wall is the exception: there the report's grade proposal is
// how a setter changes their own climb's grade (#5971). The climb-actions menu
// applies the same rule.

/** Can a climber report a climb they set on this board? Spray walls only. */
export function ownClimbIsReportable(boardName: string | null | undefined): boolean {
  return boardName === 'spray';
}

export function canReportDisplayedClimb(options: {
  isAuthenticated: boolean;
  moderationEnabled: boolean;
  climb: { is_draft?: boolean | null; userId?: string | null } | null | undefined;
  currentUserId: string | null | undefined;
  boardName?: string | null;
}): boolean {
  const { isAuthenticated, moderationEnabled, climb, currentUserId, boardName } = options;
  if (!isAuthenticated || !moderationEnabled || !climb) return false;
  if (climb.is_draft === true) return false;
  if (ownClimbIsReportable(boardName)) return true;
  return !(currentUserId && climb.userId === currentUserId);
}
