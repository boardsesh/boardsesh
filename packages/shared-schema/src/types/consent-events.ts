// Consent event types

export type ConsentRejectionSource = 'banner' | 'dialog' | 'settings';

export type RecordConsentRejectionInput = {
  // Narrowed to the literal union — the backend Zod schema rejects anything
  // outside this set, and TypeScript callers should respect the same contract.
  source: ConsentRejectionSource;
};
