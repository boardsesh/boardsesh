export type AppFeedbackPlatform = 'ios' | 'android' | 'web';
export type AppFeedbackSource = 'prompt' | 'drawer_feedback' | 'shake_bug' | 'drawer_bug';

export type SubmitAppFeedbackInput = {
  rating?: number | null;
  comment?: string | null;
  platform: AppFeedbackPlatform;
  appVersion?: string | null;
  source: AppFeedbackSource;
};
