/** The signed-in climber's "Email me project news" answer. See docs/project-news-email.md. */
export type ProjectNewsEmailConsent = {
  subscribed: boolean;
  /** ISO 8601, stamped by the server; null when the climber never answered. */
  decidedAt: string | null;
};

/** Where a climber flipped the Settings switch. The unsubscribe link records `email_link` server-side. */
export type ProjectNewsEmailSource = 'web' | 'ios' | 'android';

export type SetProjectNewsEmailConsentInput = {
  subscribed: boolean;
  source: ProjectNewsEmailSource;
};
