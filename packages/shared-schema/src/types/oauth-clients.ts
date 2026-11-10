/** Wire shapes for the developer console's operations (docs/integration-platform.md "Self-service registration"). */
export type OAuthClientApplicationType = 'WEB' | 'NATIVE';

export type OAuthClientAuthMethod = 'NONE' | 'CLIENT_SECRET_BASIC' | 'CLIENT_SECRET_POST';

export type OAuthClient = {
  clientId: string;
  name: string;
  /** "Made by" on the consent screen. Null only for an app registered before publishers were recorded. */
  publisherName: string | null;
  homepageUrl: string | null;
  privacyPolicyUrl: string;
  applicationType: OAuthClientApplicationType;
  tokenEndpointAuthMethod: OAuthClientAuthMethod;
  redirectUris: string[];
  /** ISO 8601. */
  createdAt: string;
  /** ISO 8601, or null while the app is not suspended. */
  suspendedAt: string | null;
  suspensionReason: string | null;
  maxActiveConnections: number;
  maxNewConnectionsPerDay: number;
  /** Climbers connected now. Deleting the app disconnects them. */
  activeConnections: number;
};

export type OAuthClientCredentials = {
  client: OAuthClient;
  /** Shown once. Null for a public app. */
  clientSecret: string | null;
};

export type CreateOAuthClientInput = {
  name: string;
  publisherName: string;
  homepageUrl?: string | null;
  privacyPolicyUrl: string;
  applicationType: OAuthClientApplicationType;
  tokenEndpointAuthMethod: OAuthClientAuthMethod;
  redirectUris: string[];
  /** The developer terms version the developer accepted; must be the current one. */
  acceptedTermsVersion: string;
};

export type UpdateOAuthClientInput = {
  clientId: string;
  name?: string | null;
  publisherName?: string | null;
  homepageUrl?: string | null;
  privacyPolicyUrl?: string | null;
  redirectUris?: string[] | null;
};
