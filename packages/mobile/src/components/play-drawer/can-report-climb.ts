// Whether the play drawer offers "Report climb" for the climb on display. A draft
// is visible to its setter alone, and you cannot usefully report your own climb
// (#5960); the iOS reaction menu applies the same owner rule.
export function canReportDisplayedClimb(options: {
  isAuthenticated: boolean;
  moderationEnabled: boolean;
  climb: { is_draft?: boolean | null; userId?: string | null } | null | undefined;
  currentUserId: string | null | undefined;
}): boolean {
  const { isAuthenticated, moderationEnabled, climb, currentUserId } = options;
  if (!isAuthenticated || !moderationEnabled || !climb) return false;
  if (climb.is_draft === true) return false;
  return !(currentUserId && climb.userId === currentUserId);
}
