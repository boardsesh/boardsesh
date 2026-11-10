export const PARTNER_ISSUER = 'https://api.boardsesh.com/api/auth';
export const PARTNER_RESOURCE = 'https://api.boardsesh.com/v1';
export const PARTNER_WEB_ORIGIN = 'https://www.boardsesh.com';

/**
 * Scopes a partner app may request. `openid` stays out because OIDC discovery is
 * not offered. `logbook:read` joins when GET /v1/logbook/changes ships (L4), so
 * the discovery document only publishes what exists.
 */
export const PARTNER_SCOPES = ['profile:read', 'offline_access'];

/** The consent link is signed with `codeExpiresIn`, so it stays 600 and the code row is cut to 60 s at issuance. */
export const PARTNER_SIGNED_QUERY_LIFETIME_SECONDS = 600;
export const PARTNER_AUTHORIZATION_CODE_LIFETIME_SECONDS = 60;

const MINIMUM_SECRET_LENGTH = 32;

export interface PartnerSecret {
  version: number;
  value: string;
}

export interface PartnerAuthorityConfiguration {
  issuer: string;
  resource: string;
  webOrigin: string;
  /** Newest first. The newest encrypts; older versions only decrypt. */
  secrets: PartnerSecret[];
  /**
   * Decrypts the www NextAuth session cookie, the only source of a signed-in
   * climber here. Read-only: the authority never writes that cookie.
   */
  nextAuthSecret: string;
}

export class PartnerAuthorityConfigurationError extends Error {
  constructor(message: string) {
    super(`Partner OAuth authority: ${message}`);
    this.name = 'PartnerAuthorityConfigurationError';
  }
}

/** `PARTNER_OAUTH_SECRETS` uses Better Auth's `version:value,version:value` format, newest first. */
export function parsePartnerSecrets(rawSecrets: string | undefined): PartnerSecret[] {
  if (!rawSecrets?.trim()) {
    throw new PartnerAuthorityConfigurationError('PARTNER_OAUTH_SECRETS is required when the mode is not off.');
  }
  const secrets = rawSecrets.split(',').map((entry) => {
    const separatorIndex = entry.indexOf(':');
    const version = Number.parseInt(entry.slice(0, separatorIndex), 10);
    const value = entry.slice(separatorIndex + 1).trim();
    if (separatorIndex < 1 || !Number.isInteger(version) || version < 0 || !value) {
      throw new PartnerAuthorityConfigurationError('PARTNER_OAUTH_SECRETS entries must be "version:value".');
    }
    if (value.length < MINIMUM_SECRET_LENGTH) {
      throw new PartnerAuthorityConfigurationError(
        `PARTNER_OAUTH_SECRETS version ${version} is shorter than ${MINIMUM_SECRET_LENGTH} characters.`,
      );
    }
    return { version, value };
  });
  if (new Set(secrets.map((secret) => secret.version)).size !== secrets.length) {
    throw new PartnerAuthorityConfigurationError('PARTNER_OAUTH_SECRETS repeats a version.');
  }
  return secrets;
}

export function readPartnerAuthorityConfiguration(
  environment: NodeJS.ProcessEnv = process.env,
): PartnerAuthorityConfiguration {
  return {
    issuer: PARTNER_ISSUER,
    resource: PARTNER_RESOURCE,
    webOrigin: PARTNER_WEB_ORIGIN,
    secrets: parsePartnerSecrets(environment.PARTNER_OAUTH_SECRETS),
    nextAuthSecret: requireNextAuthSecret(environment.NEXTAUTH_SECRET),
  };
}

function requireNextAuthSecret(rawSecret: string | undefined): string {
  if (!rawSecret?.trim()) {
    throw new PartnerAuthorityConfigurationError('NEXTAUTH_SECRET is required when the mode is not off.');
  }
  return rawSecret;
}

/**
 * `BETTER_AUTH_TELEMETRY=1` beats `telemetry: { enabled: false }` in the pinned
 * package. An instance built with the flag set would publish, so this refuses
 * to build one. Reads the flag the way Better Auth reads it.
 */
export function assertPartnerTelemetryOff(environment: NodeJS.ProcessEnv = process.env): void {
  const flag = environment.BETTER_AUTH_TELEMETRY;
  if (flag && flag !== '0' && flag.toLowerCase() !== 'false') {
    throw new PartnerAuthorityConfigurationError(
      'BETTER_AUTH_TELEMETRY is set. Partner OAuth refuses to start because it would override telemetry: { enabled: false }.',
    );
  }
}
