/** Account-scoped so late report responses cannot cross an account switch. */
export const bugReportQueryKeys = {
  all: ['bug-reports'] as const,
  account: (accountId: string | undefined) => ['bug-reports', accountId] as const,
  list: (accountId: string | undefined) => ['bug-reports', accountId, 'list'] as const,
  report: (accountId: string | undefined, reportId: string) => ['bug-reports', accountId, 'report', reportId] as const,
  messages: (accountId: string | undefined, reportId: string) =>
    ['bug-reports', accountId, 'messages', reportId] as const,
};
