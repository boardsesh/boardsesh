import type { OAuthOptions } from '@better-auth/oauth-provider';

export const PROTOTYPE_ISSUER = 'https://auth.boardsesh.test/api/auth';
export const PROTOTYPE_RESOURCE = 'https://api.boardsesh.test/v1';

/** BA-01 only. Importing this configuration never mounts an auth endpoint. */
export const PROTOTYPE_OAUTH_OPTIONS = {
  loginPage: 'https://www.boardsesh.test/auth/login',
  consentPage: 'https://www.boardsesh.test/oauth/consent',
  disableJwtPlugin: true,
  allowDynamicClientRegistration: false,
  allowUnauthenticatedClientRegistration: false,
  grantTypes: ['authorization_code', 'refresh_token'],
  // openid proves OIDC discovery in this spike; it is not a partner launch decision.
  scopes: ['openid', 'profile:read', 'logbook:read', 'workouts:read', 'workouts:write', 'offline_access'],
  resources: [PROTOTYPE_RESOURCE],
  enforcePerClientResources: true,
  accessTokenExpiresIn: 3600,
  refreshTokenExpiresIn: 90 * 24 * 60 * 60,
  refreshTokenReuseInterval: 0,
  codeExpiresIn: 60,
  storeTokens: 'hashed',
  clientRegistrationRequirePKCE: true,
} satisfies OAuthOptions<string[]>;
