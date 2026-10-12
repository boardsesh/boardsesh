export type FeedbackAttachment = {
  id: string;
  kind: 'image' | 'video';
  uri: string;
  name: string;
  mimeType: string;
  size: number;
  width?: number;
  height?: number;
  duration?: number;
};

export type SharedBugDraft = {
  id: string;
  attachments: FeedbackAttachment[];
  comment: string;
  contactConsent: boolean;
  uploadedKeysByUri: Record<string, string>;
  uploadedKeysAccountId?: string;
};

export type SharedBugDraftUpdates = Partial<Omit<SharedBugDraft, 'id'>> & {
  /** IDs visible when an attachment edit began; unseen receipts must survive it. */
  attachmentBaselineIds?: readonly string[];
};

export type ShareReceiptNotice = 'unsupported' | 'overflow' | 'tooLarge' | 'failed' | 'invalidLink';
