import type { FeedbackAttachment } from './shared-bug-draft.types';
export type { FeedbackAttachment, SharedBugDraft, SharedBugDraftUpdates } from './shared-bug-draft.types';

/** Browser picker blobs are already local; OS share receipt is native-only. */
export async function stageFeedbackAttachment(attachment: FeedbackAttachment): Promise<FeedbackAttachment> {
  return attachment;
}

export function releaseOwnedFeedbackAttachments(_attachments: readonly FeedbackAttachment[]): void {}
