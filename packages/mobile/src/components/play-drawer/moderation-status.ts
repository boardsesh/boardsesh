import type { Proposal } from '@boardsesh/shared-schema';

/**
 * What the play drawer needs to say about a climb's moderation, distilled from
 * the raw proposal list. Pure so the wording component stays a render.
 */
export type ModerationStatus = {
  /**
   * The approved `hide` proposal that is currently in force, or null when the
   * climb is visible. Carries the reason and the resolver, which is what the
   * banner quotes.
   */
  hidden: Proposal | null;
  /** An open hide report — the climb is still visible, the crew is voting. */
  openHide: Proposal | null;
  /**
   * Open grade proposals for the angle being played. Grade is per-angle, so a
   * V6-at-40° proposal says nothing to someone climbing at 25°.
   */
  openGradeAtAngle: Proposal[];
};

/** Who settled a proposal: the crew's weighted votes, or a moderator's call. */
export type ProposalDecider = 'crew' | 'moderator';

/**
 * `resolvedBy` is null when a proposal cleared the vote threshold on its own and
 * carries a user id when an admin or community leader resolved it outright.
 */
export function decidedBy(proposal: Proposal): ProposalDecider {
  return proposal.resolvedBy ? 'moderator' : 'crew';
}

/** When a proposal was settled — resolution time, falling back to creation. */
function decidedAtMs(proposal: Proposal): number {
  const stamp = Date.parse(proposal.resolvedAt ?? proposal.createdAt);
  return Number.isNaN(stamp) ? 0 : stamp;
}

function createdAtMs(proposal: Proposal): number {
  const stamp = Date.parse(proposal.createdAt);
  return Number.isNaN(stamp) ? 0 : stamp;
}

/**
 * Reduce a climb's proposals to the three things the Community section shows.
 *
 * The hidden verdict reads the LATEST approved hide rather than the latest
 * approved hide that says `'true'`: unhiding is itself a `hide` proposal with
 * `proposedValue: 'false'`, so scanning only for `'true'` would keep showing the
 * banner on a climb the crew has since voted back into view.
 */
export function selectModerationStatus(proposals: Proposal[], angle: number): ModerationStatus {
  let latestHideDecision: Proposal | null = null;
  let openHide: Proposal | null = null;
  const openGradeAtAngle: Proposal[] = [];

  for (const proposal of proposals) {
    if (proposal.type === 'hide') {
      if (proposal.status === 'approved') {
        if (!latestHideDecision || decidedAtMs(proposal) > decidedAtMs(latestHideDecision)) {
          latestHideDecision = proposal;
        }
      } else if (proposal.status === 'open') {
        // At most one open hide exists per climb (the resolver joins reports
        // into it), but a stale duplicate must not win over the live one.
        if (!openHide || createdAtMs(proposal) > createdAtMs(openHide)) openHide = proposal;
      }
      continue;
    }

    if (proposal.type === 'grade' && proposal.status === 'open' && proposal.angle === angle) {
      openGradeAtAngle.push(proposal);
    }
  }

  return {
    hidden: latestHideDecision?.proposedValue === 'true' ? latestHideDecision : null,
    openHide,
    openGradeAtAngle,
  };
}
