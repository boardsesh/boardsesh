// Consent event types

export type ConsentRejectionSource = 'banner' | 'dialog' | 'settings';

export type RecordConsentRejectionInput = {
  source: ConsentRejectionSource | string;
};
