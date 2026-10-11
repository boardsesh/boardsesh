import { Share, type ShareAction } from 'react-native';
import { SHARED_EVENTS } from '@boardsesh/analytics';
import { track } from './analytics';

/**
 * The host's half of the invite funnel (#6004): the sheet was opened, and the
 * link left the app. The invitee's half is `Session Invite Page Viewed` on www
 * and `Session Joined` / `Session Join Outcome` in the app.
 */

/** How the link left the app. */
export type SessionInviteShareMethod = 'copy_link' | 'system_share';

export function trackSessionInviteSheetOpened(sessionId: string): void {
  track(SHARED_EVENTS.SessionInviteSheetOpened, { sessionId });
}

export function trackSessionInviteLinkCopied(sessionId: string): void {
  track(SHARED_EVENTS.SessionInviteShared, { sessionId, method: 'copy_link' satisfies SessionInviteShareMethod });
}

/**
 * Count a system share from what the platform said about it.
 *
 * iOS resolves `Share.share` with `dismissedAction` when the sheet was closed
 * without picking anything, and names the chosen app in `activityType`
 * (`com.apple.UIKit.activity.Message`, `net.whatsapp.WhatsApp.ShareExtension`).
 * Android resolves `sharedAction` as soon as the chooser opens and says nothing
 * more, so there `system_share` means "opened the chooser", not "sent".
 */
export function trackSessionInviteSystemShare(sessionId: string, result: ShareAction): void {
  if (result.action === Share.dismissedAction) return;
  track(SHARED_EVENTS.SessionInviteShared, {
    sessionId,
    method: 'system_share' satisfies SessionInviteShareMethod,
    ...(result.activityType ? { shareTarget: result.activityType } : {}),
  });
}
