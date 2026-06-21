// Shared types for the external-platform integration providers. One provider
// implementation (Strava today) per supported platform; the registry maps the
// DB `provider` column to an implementation.

/** Tokens returned by an OAuth provider after exchange/refresh. */
export type ProviderTokens = {
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
  externalAccountId: string;
  externalAccountName: string | null;
  scopes: string | null;
};

/** A session rendered into the fields an external activity needs. */
export type SessionActivityInput = {
  name: string;
  description: string;
  /** ISO 8601 local start time. */
  startDateLocal: string;
  elapsedSeconds: number;
};

/**
 * One external-platform provider. Implementations wrap the provider's OAuth +
 * activity-upload HTTP surface; all I/O lives behind these methods so the
 * credential/export services stay provider-agnostic.
 */
export type IntegrationProviderImpl = {
  readonly provider: 'strava';
  buildAuthorizeUrl(state: string, redirectUri: string): string;
  exchangeCode(code: string, redirectUri: string): Promise<ProviderTokens>;
  /**
   * Exchange a refresh token for a fresh access token. The refresh token may
   * rotate — callers MUST persist the returned refreshToken.
   */
  refreshTokens(refreshToken: string): Promise<Pick<ProviderTokens, 'accessToken' | 'refreshToken' | 'expiresAt'>>;
  uploadSessionActivity(
    accessToken: string,
    activity: SessionActivityInput,
  ): Promise<{ externalActivityId: string; url: string }>;
  /** Web URL of an activity on the provider, from its external id. */
  activityUrl(externalActivityId: string): string;
  /** Best-effort token revocation. Implementations should not throw on failure. */
  revoke(accessToken: string): Promise<void>;
};
