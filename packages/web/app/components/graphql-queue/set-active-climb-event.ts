// Source tags for the centrally-fired PostHog "Set Active Climb" event.
// Typed as a union so the call sites get compile-time typo protection and
// PostHog dashboards can rely on this exact set of values for breakdowns.
export type SetActiveClimbSource =
  | 'setCurrentClimb'
  | 'setCurrentClimbQueueItem'
  | 'bridge.setCurrentClimb'
  | 'bridge.setCurrentClimbQueueItem.party'
  | 'bridge.setCurrentClimbQueueItem.solo';
