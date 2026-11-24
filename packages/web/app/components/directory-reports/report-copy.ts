import type { TFunction } from 'i18next';
import {
  SETUP_CHANGES_PER_CLIMBER_PER_DAY,
  type ReportAudience,
  type SetupSuggestionPreview,
} from '@boardsesh/directory-moderation';
import type {
  BoardSetupReviewReason,
  DirectoryReportReason,
  DirectoryReportTargetKind,
} from '@boardsesh/shared-schema';

/**
 * A report reason as a climber reads it. Static-literal keys: the i18n linter
 * refuses `t(variable)`. Board and gym share the ids `duplicate` and `other`
 * but not their words, so the target kind picks the list.
 */
export function reportReasonLabel(
  reason: DirectoryReportReason,
  targetKind: DirectoryReportTargetKind,
  t: TFunction<'boards'>,
): string {
  if (targetKind === 'gym') {
    switch (reason) {
      case 'duplicate':
        return t('report.gymReasons.duplicate');
      case 'closed':
        return t('report.gymReasons.closed');
      case 'wrong_details':
        return t('report.gymReasons.details');
      case 'not_a_gym':
        return t('report.gymReasons.home');
      default:
        return t('report.gymReasons.other');
    }
  }
  switch (reason) {
    case 'wrong_setup':
      return t('report.boardReasons.wrongSetup');
    case 'duplicate':
      return t('report.boardReasons.duplicate');
    case 'gone':
      return t('report.boardReasons.gone');
    case 'wrong_place':
      return t('report.boardReasons.wrongPlace');
    case 'relist_request':
      return t('report.boardReasons.relistRequest');
    default:
      return t('report.boardReasons.other');
  }
}

/** The line under a reason in the dialog, or null for the reasons that need none. */
export function reportReasonHint(
  reason: DirectoryReportReason,
  targetKind: DirectoryReportTargetKind,
  t: TFunction<'boards'>,
): string | null {
  if (targetKind === 'gym') {
    switch (reason) {
      case 'duplicate':
        return t('report.gymReasons.duplicateHint');
      case 'not_a_gym':
        return t('report.gymReasons.homeHint');
      default:
        return null;
    }
  }
  switch (reason) {
    case 'wrong_setup':
      return t('report.boardReasons.wrongSetupHint');
    case 'duplicate':
      return t('report.boardReasons.duplicateHint');
    case 'gone':
      return t('report.boardReasons.goneHint');
    case 'wrong_place':
      return t('report.boardReasons.wrongPlaceHint');
    default:
      return null;
  }
}

/**
 * The routing line at the foot of the dialog: who will read the report. The
 * audience comes from `reportAudienceFor`, so the line never names a reader the
 * server won't reach.
 */
export function reportAudienceLine(
  audience: ReportAudience,
  names: { creator: string | null; gym: string | null },
  t: TFunction<'boards'>,
): string {
  const name = names.creator ?? '';
  const gym = names.gym ?? '';
  switch (audience) {
    case 'creator':
      return t('report.routeCreator', { name });
    case 'creator_hidden':
      return t('report.routeCreatorHidden');
    case 'creator_and_staff':
      return t('report.routeCreatorAndStaff', { name, gym });
    case 'creator_hidden_and_staff':
      return t('report.routeCreatorHiddenAndStaff', { gym });
    case 'creator_and_team':
      return t('report.routeCreatorAndTeam', { name });
    case 'creator_hidden_and_team':
      return t('report.routeCreatorHiddenAndTeam');
    case 'creator_staff_and_team':
      return t('report.routeCreatorStaffAndTeam', { name, gym });
    case 'creator_hidden_staff_and_team':
      return t('report.routeCreatorHiddenStaffAndTeam', { gym });
    case 'staff':
      return t('report.routeStaff', { gym });
    case 'staff_and_team':
      return t('report.routeGymAndStaff', { gym });
    case 'team_unclaimed_gym':
      return t('report.routeTeam', { gym });
    case 'team':
      return t('report.routeGym');
  }
}

/**
 * The line at the foot of the dialog once the setup fields show: what Send does
 * with the suggestion (`setupPreviewFor`). It takes the routing line's place.
 */
export function setupPreviewLine(preview: SetupSuggestionPreview, gym: string | null, t: TFunction<'boards'>): string {
  switch (preview) {
    case 'applies_for_everyone':
      return t('report.web.setup.previewEveryone', { gym: gym ?? '' });
    case 'staff_review':
      return t('report.web.setup.previewStaff', { gym: gym ?? '' });
    case 'creator_review':
      return t('report.web.setup.previewCreator');
  }
}

/** The done state for a suggestion that went to review, by the server's reason. */
export function setupReviewLine(reason: BoardSetupReviewReason, gym: string | null, t: TFunction<'boards'>): string {
  switch (reason) {
    case 'CLAIMED_GYM':
      return gym ? t('report.web.setup.reviewClaimedGym', { gym }) : t('report.web.setup.reviewClaimedGymUnnamed');
    case 'NO_GYM':
      return t('report.web.setup.reviewNoGym');
    case 'RECENT_CHANGE':
      return t('report.web.setup.reviewRecentChange');
    case 'RECENTLY_UNDONE':
      return t('report.web.setup.reviewRecentlyUndone');
    case 'DAILY_LIMIT':
      return t('report.web.setup.reviewDailyLimit', { limit: SETUP_CHANGES_PER_CLIMBER_PER_DAY });
    case 'CLASHES':
      return t('report.web.setup.reviewClashes');
  }
}
