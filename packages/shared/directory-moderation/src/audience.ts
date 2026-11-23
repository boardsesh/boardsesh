import type { DirectoryReportRecipient, DirectoryReportTargetKind, GymListingState } from './reasons';

/**
 * The line at the foot of the report sheet that says who will read the report,
 * picked from the same routing the server uses (`routeBoardReport` /
 * `routeGymReport`), so the sheet never promises a reader nobody is.
 *
 * Returns an audience id, not a translation key: the web and mobile linters
 * refuse `t(variable)`, so each client switches over the id and calls `t()`
 * with a literal. {@link REPORT_AUDIENCE_COPY_KEYS} names the `boards`
 * catalogue key each id is worded with, so both clients use the same words.
 */
export type ReportAudience =
  | 'creator'
  | 'creator_hidden'
  | 'creator_and_staff'
  | 'creator_hidden_and_staff'
  | 'creator_and_team'
  | 'creator_hidden_and_team'
  | 'creator_staff_and_team'
  | 'creator_hidden_staff_and_team'
  | 'staff'
  | 'staff_and_team'
  | 'team_unclaimed_gym'
  | 'team';

/**
 * The `boards` namespace key each audience is worded with. Placeholders:
 * `{{name}}` is the creator's display name, `{{gym}}` the gym's name.
 */
export const REPORT_AUDIENCE_COPY_KEYS = {
  creator: 'report.routeCreator',
  creator_hidden: 'report.routeCreatorHidden',
  creator_and_staff: 'report.routeCreatorAndStaff',
  creator_hidden_and_staff: 'report.routeCreatorHiddenAndStaff',
  creator_and_team: 'report.routeCreatorAndTeam',
  creator_hidden_and_team: 'report.routeCreatorHiddenAndTeam',
  creator_staff_and_team: 'report.routeCreatorStaffAndTeam',
  creator_hidden_staff_and_team: 'report.routeCreatorHiddenStaffAndTeam',
  staff: 'report.routeStaff',
  staff_and_team: 'report.routeGymAndStaff',
  team_unclaimed_gym: 'report.routeTeam',
  team: 'report.routeGym',
} as const satisfies Record<ReportAudience, string>;

export type ReportAudienceInput = {
  targetKind: DirectoryReportTargetKind;
  /** `routing.recipients` from `routeBoardReport` / `routeGymReport`. */
  recipients: readonly DirectoryReportRecipient[];
  /**
   * The viewer may see the creator's name (`UserBoard.ownerDisplayName` is
   * set). When it isn't, the line says "the climber who added this board".
   */
  creatorNameVisible: boolean;
  /** The board's gym, for the "nobody runs {{gym}} yet" wording. Null without a gym. */
  gymListingState: GymListingState | null;
};

export function pickReportAudience(input: ReportAudienceInput): ReportAudience {
  const toCreator = input.targetKind === 'board' && input.recipients.includes('creator');
  const toStaff = input.recipients.includes('gym_staff');
  const toTeam = input.recipients.includes('admin');
  const named = input.creatorNameVisible;

  if (toCreator && toStaff && toTeam) return named ? 'creator_staff_and_team' : 'creator_hidden_staff_and_team';
  if (toCreator && toStaff) return named ? 'creator_and_staff' : 'creator_hidden_and_staff';
  if (toCreator && toTeam) return named ? 'creator_and_team' : 'creator_hidden_and_team';
  if (toCreator) return named ? 'creator' : 'creator_hidden';
  if (toStaff && toTeam) return 'staff_and_team';
  if (toStaff) return 'staff';
  // Only the team: say why when the reason is that nobody runs the gym yet,
  // which is when the sheet also offers the claim.
  if (input.targetKind === 'board' && input.gymListingState === 'UNCLAIMED') return 'team_unclaimed_gym';
  return 'team';
}
