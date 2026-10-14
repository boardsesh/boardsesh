/** Identity of the JavaScript bundle currently running on the reporting device. */
export type ReleaseContextInput = {
  channel?: string | null;
  branch?: string | null;
  updateId?: string | null;
  runtimeVersion?: string | null;
  isEmbeddedLaunch?: boolean | null;
};

/** Canary membership is checked by the backend, never supplied by a client. */
export type ReleaseContext = {
  channel: string | null;
  branch: string | null;
  updateId: string | null;
  runtimeVersion: string | null;
  isEmbeddedLaunch: boolean | null;
  automaticCanary: boolean | null;
  canaryCheckedAt: string | null;
};

export type MobileReleaseStatusInput = ReleaseContextInput & {
  platform: 'ios' | 'android' | 'web';
};

export type ProposalReportReleaseContext = {
  commentUuid: string;
  releaseContext: ReleaseContext;
};
