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
// Time formatting is NOT here: rows call `formatTickRelativeTime` from
// `@boardsesh/profile-stats`. Web's `formatTimeAgo` ends in
// `date.toLocaleDateString()`, which is exactly the Intl surface the mobile
// lint config bans (Hermes ships without it).

import type { GroupedNotification, NotificationType } from '@boardsesh/shared-schema';
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
 * Every report string names the climb, so each one is gated on `climbName` and
 * falls back to the climb-free key — the same swap the comment rows do on
 * `commentBody` and `gym_claim_approved` does on `gymName`, and for the same
 * reason: this module cannot call `t`, so there is no fallback *word* to
 * interpolate.
 */
export function notificationCopy(notification: GroupedNotification, actor: string): CopyDescriptor {
  const { commentBody, setterUsername, gymName, proposalType, climbName } = notification;
  const climb = climbName ?? null;
  const isHide = proposalType === 'hide';

  switch (notification.type) {
    case 'new_follower':
      return { textI18nKey: 'items.newFollower', params: { actor } };
    case 'comment_reply':
      return commentBody
        ? { textI18nKey: 'items.commentReplyWithBody', params: { actor, body: commentBody } }
        : { textI18nKey: 'items.commentReply', params: { actor } };
    case 'comment_on_tick':
      return commentBody
        ? { textI18nKey: 'items.commentOnTickWithBody', params: { actor, body: commentBody } }
        : { textI18nKey: 'items.commentOnTick', params: { actor } };
    case 'comment_on_climb':
      return commentBody
        ? { textI18nKey: 'items.commentOnClimbWithBody', params: { actor, body: commentBody } }
        : { textI18nKey: 'items.commentOnClimb', params: { actor } };
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
      return { textI18nKey: 'items.newClimb', params: { actor } };
    case 'new_climbs_synced':
      return setterUsername
        ? { textI18nKey: 'items.newClimbsSyncedSetter', params: { setter: setterUsername } }
        : { textI18nKey: 'items.newClimbsSynced', params: { actor } };
    case 'gym_claim_approved':
      return gymName
        ? { textI18nKey: 'items.gymClaimApproved', params: { gym: gymName } }
        : { textI18nKey: 'items.gymClaimApprovedGeneric', params: {} };
    // The backend can add a notification type without a client release, so an
    // unrecognised one still renders a row rather than a blank line.
    default:
      return { textI18nKey: 'items.default', params: {} };
  }
}

/** The leading glyph for a row, matching web's icon choice per type. */
export function notificationIconName(type: NotificationType): IconName {
  switch (type) {
    case 'new_follower':
      return 'person.badge.plus';
    case 'comment_reply':
    case 'comment_on_tick':
    case 'comment_on_climb':
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
      return 'gym';
    default:
      return 'notification';
  }
}
