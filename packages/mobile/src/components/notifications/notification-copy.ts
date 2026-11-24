// The i18n-key / icon mapping behind a notification row.
//
// Returns *descriptors* rather than rendered strings, so this module stays
// pure: no `t`, no React, no i18next import. The screen holds the
// `useTranslation('notifications')` and resolves the keys. That split is also
// what makes the table test possible — every branch is asserted against web's
// `notification-item.tsx` without a render.
//
// Deliberately a standalone leaf. Web's copy currently lives inside its
// notification-item component; if that ever gets extracted into a shared
// package, this file moves as-is rather than being rewritten.
//
// Time formatting is NOT here: rows call `formatRelativeTime` from
// `lib/format-relative-time.ts` (the frozen-clock-aware wrapper around
// `@boardsesh/profile-stats`'s `formatTickRelativeTime`). Web's `formatTimeAgo`
// ends in `date.toLocaleDateString()`, which is exactly the Intl surface the
// mobile lint config bans (Hermes ships without it).

import type { DirectoryNotice, GroupedNotification, NotificationType } from '@boardsesh/shared-schema';
import type { IconName } from '../icon-map';

/**
 * An i18n key plus its interpolation params, ready for
 * `t(descriptor.textI18nKey, descriptor.params)`.
 *
 * The `…I18nKey` suffix is load-bearing, not decoration: `check:i18n:orphans`
 * treats a property with that name as a key holder, so it records the literal
 * at each `return` below AND accepts the row's `t(copy.textI18nKey, …)` as
 * statically resolved. Rename the field and the checker hard-fails the row's
 * call as an unanalyzable `t()` argument and reports all 19 `items.*` strings
 * as orphans.
 */
export type CopyDescriptor = {
  textI18nKey: string;
  params: Record<string, string | number>;
};

/**
 * A single actor resolves to a bare display name — there is no key to
 * translate, the name IS the answer — while every multi-actor case needs one.
 * Modelling that as a union keeps the module key-free rather than inventing an
 * `actorSummary.name: "{{name}}"` passthrough in four catalogs.
 */
export type ActorSummary = { kind: 'literal'; text: string } | ({ kind: 'key' } & CopyDescriptor);

/**
 * The already-translated `actorSummary.fallback` / `actorSummary.secondaryFallback`
 * strings ("Someone" / "someone"), injected because this module cannot call `t`.
 */
export type ActorFallbacks = {
  primary: string;
  secondary: string;
};

/** The actor fields the copy helpers read — a structural subset of `GroupedNotification`. */
type ActorSource = Pick<GroupedNotification, 'actors' | 'actorCount'>;

/**
 * "Alex", "Alex and Sam", "Alex and 1 other", "Alex and 4 others" — the same
 * ladder web walks in `getActorSummary`, resolved to a descriptor so the caller
 * can translate it.
 */
export function actorSummary(notification: ActorSource, fallbacks: ActorFallbacks): ActorSummary {
  const { actors, actorCount } = notification;
  if (actors.length === 0) return { kind: 'literal', text: fallbacks.primary };

  const first = actors[0].displayName || fallbacks.primary;
  if (actorCount === 1) return { kind: 'literal', text: first };

  if (actorCount === 2 && actors.length >= 2) {
    const second = actors[1].displayName || fallbacks.secondary;
    return { kind: 'key', textI18nKey: 'actorSummary.two', params: { first, second } };
  }

  const othersCount = actorCount - 1;
  if (othersCount === 1) return { kind: 'key', textI18nKey: 'actorSummary.manyOne', params: { first } };
  return { kind: 'key', textI18nKey: 'actorSummary.many', params: { first, count: othersCount } };
}

/**
 * The row's body copy. `actor` arrives already-translated (the screen resolves
 * {@link actorSummary} first) because every `items.*` string interpolates the
 * actor summary as one opaque token, exactly as web does.
 *
 * `proposalType` splits the proposal rows: a hide proposal is a *report* in the
 * product's language ("reported", "hid it", "closed without hiding"), and a
 * setter reading "created a new proposal" about their climb being pulled would
 * miss what happened.
 *
 * `proposalValue` splits them once more. A hide proposal carries 'true' to pull
 * a climb and 'false' to put it back, so the report wording only fits the first
 * one — telling a setter their climb was "reported" when someone asked for it to
 * be restored says the opposite of what happened. An older backend sends no
 * value at all, and a hide with nothing to go on stays a report, which is what
 * every hide proposal was before unhide existed.
 *
 * Every report string names the climb, so each one is gated on `climbName` and
 * falls back to the climb-free key — the same swap the comment rows do on
 * `commentBody` and `gym_claim_approved` does on `gymName`, and for the same
 * reason: this module cannot call `t`, so there is no fallback *word* to
 * interpolate.
 */
export function notificationCopy(notification: GroupedNotification, actor: string): CopyDescriptor {
  const { commentBody, setterUsername, gymName, proposalType, proposalValue, climbName } = notification;
  const climb = climbName ?? null;
  const isHide = proposalType === 'hide' && proposalValue !== 'false';

  switch (notification.type) {
    case 'app_feedback_reply':
      return { textI18nKey: 'items.bugReportReply', params: {} };
    case 'new_follower':
      return { textI18nKey: 'items.newFollower', params: { actor } };
    case 'follow_request':
      return { textI18nKey: 'items.followRequest', params: { actor } };
    case 'comment_reply':
      return commentBody
        ? { textI18nKey: 'items.commentReplyWithBody', params: { actor, body: commentBody } }
        : { textI18nKey: 'items.commentReply', params: { actor } };
    case 'comment_on_tick':
      return commentBody
        ? { textI18nKey: 'items.commentOnTickWithBody', params: { actor, body: commentBody } }
        : { textI18nKey: 'items.commentOnTick', params: { actor } };
    // The owner rows (#6385). With a comment preview the body fills the two
    // lines, so it says only what was commented on; without one, the climb or
    // gym is named when the group carries its name.
    case 'comment_on_climb':
      if (commentBody) return { textI18nKey: 'items.commentOnClimbWithBody', params: { actor, body: commentBody } };
      return climb
        ? { textI18nKey: 'items.commentOnClimb', params: { actor, climb } }
        : { textI18nKey: 'items.commentOnClimbGeneric', params: { actor } };
    case 'comment_on_session':
      return commentBody
        ? { textI18nKey: 'items.commentOnSessionWithBody', params: { actor, body: commentBody } }
        : { textI18nKey: 'items.commentOnSession', params: { actor } };
    case 'comment_on_playlist':
      return commentBody
        ? { textI18nKey: 'items.commentOnPlaylistWithBody', params: { actor, body: commentBody } }
        : { textI18nKey: 'items.commentOnPlaylist', params: { actor } };
    case 'comment_on_board':
      // A spray wall is a Spraywall in every locale, never a bare board
      // ("plafón", "Board"), so it gets its own pair of keys.
      if (notification.boardType === 'spray') {
        return commentBody
          ? { textI18nKey: 'items.commentOnSprayWallWithBody', params: { actor, body: commentBody } }
          : { textI18nKey: 'items.commentOnSprayWall', params: { actor } };
      }
      return commentBody
        ? { textI18nKey: 'items.commentOnBoardWithBody', params: { actor, body: commentBody } }
        : { textI18nKey: 'items.commentOnBoard', params: { actor } };
    case 'comment_on_gym':
      if (commentBody) return { textI18nKey: 'items.commentOnGymWithBody', params: { actor, body: commentBody } };
      return gymName
        ? { textI18nKey: 'items.commentOnGym', params: { actor, gym: gymName } }
        : { textI18nKey: 'items.commentOnGymGeneric', params: { actor } };
    case 'vote_on_tick':
      return { textI18nKey: 'items.voteOnTick', params: { actor } };
    case 'vote_on_comment':
      return { textI18nKey: 'items.voteOnComment', params: { actor } };
    case 'proposal_created':
      return isHide && climb
        ? { textI18nKey: 'items.proposalCreatedHide', params: { actor, climb } }
        : { textI18nKey: 'items.proposalCreated', params: { actor } };
    case 'proposal_approved':
      return isHide && climb
        ? { textI18nKey: 'items.proposalApprovedHide', params: { actor, climb } }
        : { textI18nKey: 'items.proposalApproved', params: { actor } };
    case 'proposal_rejected':
      return isHide && climb
        ? { textI18nKey: 'items.proposalRejectedHide', params: { actor, climb } }
        : { textI18nKey: 'items.proposalRejected', params: { actor } };
    case 'proposal_vote':
      return isHide && climb
        ? { textI18nKey: 'items.proposalVoteHide', params: { actor, climb } }
        : { textI18nKey: 'items.proposalVote', params: { actor } };
    case 'proposal_on_your_climb':
      if (!climb) return { textI18nKey: 'items.proposalOnYourClimbGeneric', params: { actor } };
      if (isHide) return { textI18nKey: 'items.proposalOnYourClimbHide', params: { actor, climb } };
      if (proposalType === 'grade') return { textI18nKey: 'items.proposalOnYourClimbGrade', params: { actor, climb } };
      // classic / benchmark / a type this client predates: still name the climb,
      // just don't claim to know which kind of change was proposed.
      return { textI18nKey: 'items.proposalOnYourClimb', params: { actor, climb } };
    case 'new_climb':
    case 'new_climb_global':
      // A setter whose account the viewer may not see arrives with no actor.
      // The climb's setter name is public, so it names them instead of "Someone".
      return {
        textI18nKey: 'items.newClimb',
        params: { actor: notification.actors.length === 0 && setterUsername ? setterUsername : actor },
      };
    case 'new_climbs_synced':
      return setterUsername
        ? { textI18nKey: 'items.newClimbsSyncedSetter', params: { setter: setterUsername } }
        : { textI18nKey: 'items.newClimbsSynced', params: { actor } };
    case 'spray_wall_detection_completed':
      return notification.sprayWallName
        ? { textI18nKey: 'items.sprayWallReady', params: { wall: notification.sprayWallName } }
        : { textI18nKey: 'items.sprayWallReadyGeneric', params: {} };
    case 'gym_claim_approved':
      return gymName
        ? { textI18nKey: 'items.gymClaimApproved', params: { gym: gymName } }
        : { textI18nKey: 'items.gymClaimApprovedGeneric', params: {} };
    case 'board_report_opened':
    case 'board_report_resolved':
    case 'board_removed_from_gym':
    case 'board_deleted_by_staff':
    case 'board_edited_by_staff':
    case 'gym_report_opened':
    case 'gym_report_resolved':
    case 'gym_claimed_with_your_board':
    case 'gym_claim_denied':
    case 'board_setup_changed_by_climber':
      return directoryNoticeCopy(notification.type, notification.directoryNotice ?? null, gymName ?? null);
    // The backend can add a notification type without a client release, so an
    // unrecognised one still renders a row rather than a blank line.
    default:
      return { textI18nKey: 'items.default', params: {} };
  }
}

type DirectoryNoticeType = Extract<
  NotificationType,
  | 'board_report_opened'
  | 'board_report_resolved'
  | 'board_removed_from_gym'
  | 'board_deleted_by_staff'
  | 'board_edited_by_staff'
  | 'gym_report_opened'
  | 'gym_report_resolved'
  | 'gym_claimed_with_your_board'
  | 'gym_claim_denied'
  | 'board_setup_changed_by_climber'
>;

/**
 * The row for a directory notice that is missing the name its sentence needs
 * (no `directoryNotice` selected, a deleted gym): what happened, without the
 * board or gym. Never `items.default`.
 */
function genericDirectoryCopy(type: DirectoryNoticeType): CopyDescriptor {
  switch (type) {
    case 'board_report_opened':
      return { textI18nKey: 'items.boardReportOpenedGeneric', params: {} };
    case 'board_report_resolved':
      return { textI18nKey: 'items.boardReportResolvedGeneric', params: {} };
    case 'board_removed_from_gym':
      return { textI18nKey: 'items.boardRemovedFromGymGeneric', params: {} };
    case 'board_deleted_by_staff':
      return { textI18nKey: 'items.boardDeletedByStaffGeneric', params: {} };
    case 'board_edited_by_staff':
      return { textI18nKey: 'items.boardEditedByStaffGeneric', params: {} };
    case 'gym_report_opened':
      return { textI18nKey: 'items.gymReportOpenedGeneric', params: {} };
    case 'gym_report_resolved':
      return { textI18nKey: 'items.gymReportResolvedGeneric', params: {} };
    case 'gym_claimed_with_your_board':
      return { textI18nKey: 'items.gymClaimedWithYourBoardGeneric', params: {} };
    case 'gym_claim_denied':
      return { textI18nKey: 'items.gymClaimDeniedGeneric', params: {} };
    case 'board_setup_changed_by_climber':
      return { textI18nKey: 'items.boardSetupChangedByClimberGeneric', params: {} };
  }
}

/**
 * Report a problem and staff actions on boards (docs/product/directory-reports.md).
 * These rows have no actor: a reporter stays anonymous, so who acted is carried
 * as a role (`actorRole`, `resolvedByRole`) on `directoryNotice`. Every specific
 * key names the board or gym, so a row missing the name it needs reads the
 * type's generic sentence instead of interpolating nothing.
 */
export function directoryNoticeCopy(
  type: DirectoryNoticeType,
  notice: DirectoryNotice | null,
  fallbackGymName: string | null,
): CopyDescriptor {
  const generic = genericDirectoryCopy(type);
  if (!notice) return generic;
  const board = notice.boardName ?? null;
  const gym = notice.gymName ?? fallbackGymName;
  const byModerator = notice.actorRole === 'moderator';
  switch (type) {
    case 'board_report_opened': {
      if (!board) return generic;
      if (notice.reason === 'relist_request') {
        return gym ? { textI18nKey: 'items.boardRelistRequested', params: { board, gym } } : generic;
      }
      if (notice.isReminder) return { textI18nKey: 'items.boardReportReminder', params: { board } };
      // Staff hear about a climber's board at their gym; only its creator reads
      // "your board".
      if (!notice.recipientIsCreator) {
        return gym ? { textI18nKey: 'items.gymBoardReported', params: { board, gym } } : generic;
      }
      switch (notice.reason) {
        case 'wrong_setup':
          return { textI18nKey: 'items.boardReportedWrongSetup', params: { board } };
        case 'duplicate':
          return { textI18nKey: 'items.boardReportedDuplicate', params: { board } };
        case 'gone':
          return { textI18nKey: 'items.boardReportedGone', params: { board } };
        case 'wrong_place':
          return { textI18nKey: 'items.boardReportedWrongPlace', params: { board } };
        default:
          return { textI18nKey: 'items.boardReportedOther', params: { board } };
      }
    }
    case 'board_report_resolved': {
      if (!board) return generic;
      // A relist request's reporter is the board's creator, hearing whether
      // the gym put it back.
      if (notice.reason === 'relist_request') {
        if (!gym) return generic;
        if (notice.outcome === 'fixed') return { textI18nKey: 'items.boardRelisted', params: { board, gym } };
        if (notice.outcome === 'kept') return { textI18nKey: 'items.boardRelistDeclined', params: { board, gym } };
        return generic;
      }
      switch (notice.outcome) {
        case 'fixed':
          return { textI18nKey: 'items.boardReportFixed', params: { board } };
        case 'removed':
          return gym ? { textI18nKey: 'items.boardReportRemoved', params: { board, gym } } : generic;
        case 'deleted':
          return { textI18nKey: 'items.boardReportDeleted', params: { board } };
        case 'merged':
          return { textI18nKey: 'items.boardReportMerged', params: { board } };
        case 'kept':
          if (notice.resolvedByRole === 'creator') {
            return { textI18nKey: 'items.boardReportKeptByCreator', params: { board } };
          }
          if (notice.resolvedByRole === 'gym_staff' && gym) {
            return { textI18nKey: 'items.boardReportKeptByStaff', params: { board, gym } };
          }
          return { textI18nKey: 'items.boardReportKeptByTeam', params: { board } };
        default:
          return generic;
      }
    }
    case 'board_removed_from_gym':
      if (!board || !gym) return generic;
      return byModerator
        ? { textI18nKey: 'items.boardRemovedByModerator', params: { board, gym } }
        : { textI18nKey: 'items.boardRemovedByStaff', params: { board, gym } };
    case 'board_deleted_by_staff':
      if (!board) return generic;
      if (byModerator) return { textI18nKey: 'items.boardDeletedByModerator', params: { board } };
      return gym ? { textI18nKey: 'items.boardDeletedByStaff', params: { board, gym } } : generic;
    case 'board_edited_by_staff':
      if (!board) return generic;
      if (byModerator) return { textI18nKey: 'items.boardEditedByModerator', params: { board } };
      return gym ? { textI18nKey: 'items.boardEditedByStaff', params: { board, gym } } : generic;
    case 'gym_report_opened':
      if (!gym) return generic;
      return notice.isReminder
        ? { textI18nKey: 'items.gymReportReminder', params: { gym } }
        : { textI18nKey: 'items.gymReportedWrongDetails', params: { gym } };
    case 'gym_report_resolved':
      if (!gym) return generic;
      switch (notice.outcome) {
        case 'fixed':
          return { textI18nKey: 'items.gymReportFixed', params: { gym } };
        case 'removed':
          return { textI18nKey: 'items.gymReportRemoved', params: { gym } };
        case 'deleted':
          return { textI18nKey: 'items.gymReportDeleted', params: { gym } };
        case 'merged':
          return { textI18nKey: 'items.gymReportMerged', params: { gym } };
        case 'kept':
          return notice.resolvedByRole === 'gym_staff'
            ? { textI18nKey: 'items.gymReportKeptByStaff', params: { gym } }
            : { textI18nKey: 'items.gymReportKeptByTeam', params: { gym } };
        default:
          return generic;
      }
    case 'gym_claimed_with_your_board':
      return board && gym ? { textI18nKey: 'items.gymClaimedWithYourBoard', params: { board, gym } } : generic;
    case 'gym_claim_denied':
      return gym ? { textI18nKey: 'items.gymClaimDenied', params: { gym } } : generic;
    // A climber's suggested setup changed a board at a gym nobody runs
    // (docs/product/directory-reports.md, "Suggested setup"). Its creator reads
    // "your board"; the gym's owner and admins, told too so they can undo it,
    // read the board and the gym.
    case 'board_setup_changed_by_climber':
      if (notice.recipientIsCreator) {
        return board ? { textI18nKey: 'items.boardSetupChangedByClimber', params: { board } } : generic;
      }
      return board && gym
        ? { textI18nKey: 'items.boardSetupChangedByClimberAtGym', params: { board, gym } }
        : { textI18nKey: 'items.boardSetupChangedByClimberStaffGeneric', params: {} };
  }
}

/** The leading glyph for a row, matching web's icon choice per type. */
export function notificationIconName(type: NotificationType): IconName {
  switch (type) {
    case 'app_feedback_reply':
      return 'comment';
    case 'new_follower':
    case 'follow_request':
      return 'person.badge.plus';
    case 'comment_reply':
    case 'comment_on_tick':
    case 'comment_on_climb':
    case 'comment_on_session':
    case 'comment_on_playlist':
    case 'comment_on_board':
    case 'comment_on_gym':
      return 'comment';
    case 'vote_on_tick':
    case 'vote_on_comment':
      return 'hand.thumbsup';
    case 'proposal_created':
    case 'proposal_approved':
    case 'proposal_rejected':
    case 'proposal_vote':
    // Same glyph as the rest of the proposal family: the row is still a
    // proposal, and the icon function only sees the type, never the
    // `proposalType` that would justify a flag.
    case 'proposal_on_your_climb':
      return 'lightbulb';
    case 'new_climb':
    case 'new_climb_global':
    case 'new_climbs_synced':
      return 'add';
    case 'gym_claim_approved':
    case 'gym_claimed_with_your_board':
    case 'gym_claim_denied':
      return 'gym';
    case 'board_report_opened':
    case 'gym_report_opened':
      return 'flag';
    case 'board_report_resolved':
    case 'gym_report_resolved':
      return 'checkmark.circle.fill';
    case 'board_removed_from_gym':
    case 'board_edited_by_staff':
    case 'board_setup_changed_by_climber':
      return 'boards';
    case 'board_deleted_by_staff':
      return 'delete';
    case 'spray_wall_detection_completed':
      return 'success';
    default:
      return 'notification';
  }
}
