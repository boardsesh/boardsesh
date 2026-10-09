import { needsBoardDemandFollowUp, type BoardDemandReason } from '@boardsesh/analytics';

/**
 * Which demand reasons deserve a follow-up conversation on mobile.
 *
 * The rule itself lives in `@boardsesh/analytics` (`needsBoardDemandFollowUp`)
 * because both platforms route the same three reasons — www to its support
 * page, mobile here to the bug-mode feedback sheet, where their words land in
 * the feedback pipeline (never in PostHog). This wrapper names the decision for
 * the mobile call site; `spray_wall` and `no_board_yet` close the sheet on the
 * event alone, as feature and app asks a bug report would frame wrongly.
 */
export function boardDemandNeedsFeedback(reason: BoardDemandReason): boolean {
  return needsBoardDemandFollowUp(reason);
}
