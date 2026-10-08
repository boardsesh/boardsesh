/**
 * Wire shapes for the analytics consent operations. `AnalyticsConsent` matches
 * `ConsentRecord` from `@boardsesh/consent` field for field, so a client can
 * hand the server's answer straight to `resolveConsent`. The schema types the
 * fields as `String`; the database's CHECK constraints are what hold the server
 * to these unions.
 */
export type AnalyticsConsent = {
  analytics: 'granted' | 'denied';
  version: number;
  source: 'web' | 'ios' | 'android';
  /** ISO 8601, stamped by the server. */
  decidedAt: string;
};

export type SetAnalyticsConsentInput = {
  analytics: 'granted' | 'denied';
  version: number;
  source: 'web' | 'ios' | 'android';
  /** The `decidedAt` of the account answer this client last saw; null when it saw none. */
  basedOnDecidedAt?: string | null;
};

export type ActiveUsersPlatform = 'web' | 'ios' | 'android' | 'unknown';

export type ActiveUsersPlatformCount = {
  platform: ActiveUsersPlatform;
  dailyActiveUsers: number;
  weeklyActiveUsers: number;
  monthlyActiveUsers: number;
};

export type ActiveUsersSnapshotResult = {
  /** The UTC day the daily count covers (YYYY-MM-DD). */
  day: string;
  dailyActiveUsers: number;
  weeklyActiveUsers: number;
  monthlyActiveUsers: number;
  platforms: ActiveUsersPlatformCount[];
  captured: boolean;
  durationMs: number;
};

export type UserActivityPurgeResult = {
  rowsDeleted: number;
  /** Rows dated before this UTC day (YYYY-MM-DD) were deleted. */
  cutoffDay: string;
  durationMs: number;
};
