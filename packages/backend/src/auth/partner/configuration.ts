import { PARTNER_DEVELOPER_TERMS_VERSION, PARTNER_OAUTH_ISSUER } from '@boardsesh/auth-protocol/partner-oauth';
import { isProductionSentryEnvironment } from '@boardsesh/db/client/config';

/** Shared with the www consent pages, which send the browser back to it. */
export const PARTNER_ISSUER = PARTNER_OAUTH_ISSUER;
export const PARTNER_RESOURCE = 'https://api.boardsesh.com/v1';
export const PARTNER_WEB_ORIGIN = 'https://www.boardsesh.com';

/**
 * Scopes a partner app may request, and what discovery publishes: only scopes
 * whose routes exist (launch gate 10). `logbook:read` reads
 * `GET /v1/logbook/changes` and `GET /v1/logbook/ticks/{id}`, "only me" ticks
 * included (decision 21), which the consent screen says. `openid` stays out
 * because OIDC discovery is not offered.
 */
export const PARTNER_SCOPES = ['logbook:read', 'profile:read', 'offline_access'];

/** The consent link is signed with `codeExpiresIn`, so it stays 600 and the code row is cut to 60 s at issuance. */
export const PARTNER_SIGNED_QUERY_LIFETIME_SECONDS = 600;
export const PARTNER_AUTHORIZATION_CODE_LIFETIME_SECONDS = 60;

const MINIMUM_SECRET_LENGTH = 32;
/**
 * The highest secret version accepted. Logbook cursors name the version they
 * were sealed under in nine digits (`handlers/public-api/logbook-cursor.ts`),
 * so a larger one, such as an epoch-seconds version, would make every cursor
 * this server issues unreadable to it. Refused at startup instead, so client
 * secrets and cursors always agree.
 */
export const PARTNER_SECRET_MAX_VERSION = 999_999_999;

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
  /**
   * The developer terms a registration must accept. Registration is refused
   * while it is a draft (ends in `-draft`), so no app registers against text
   * the owner has not approved.
   */
  developerTermsVersion: string;
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
    if (version > PARTNER_SECRET_MAX_VERSION) {
      throw new PartnerAuthorityConfigurationError(
        `PARTNER_OAUTH_SECRETS version ${version} is above ${PARTNER_SECRET_MAX_VERSION}: logbook cursors carry at most nine digits of version.`,
      );
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

/**
 * The developer terms registration requires. In production it is always the
 * shared constant, so publishing terms is a reviewed code change and never an
 * environment flip. Anywhere else (tests, the e2e journey, a preview) the
 * `PARTNER_DEVELOPER_TERMS_VERSION` variable may name a published version,
 * because the shipped constant may still be a draft that registers nothing.
 * "Production" is the backend's own test, the one its Sentry gate uses: Railway
 * leaves NODE_ENV unset there, so NODE_ENV alone cannot say.
 */
export function partnerDeveloperTermsVersion(environment: NodeJS.ProcessEnv, production: boolean): string {
  const override = environment.PARTNER_DEVELOPER_TERMS_VERSION?.trim();
  return !production && override ? override : PARTNER_DEVELOPER_TERMS_VERSION;
}

export function readPartnerAuthorityConfiguration(
  environment: NodeJS.ProcessEnv = process.env,
  { production = isProductionSentryEnvironment() }: { production?: boolean } = {},
): PartnerAuthorityConfiguration {
  return {
    issuer: PARTNER_ISSUER,
    resource: PARTNER_RESOURCE,
    webOrigin: PARTNER_WEB_ORIGIN,
    secrets: parsePartnerSecrets(environment.PARTNER_OAUTH_SECRETS),
    nextAuthSecret: requireNextAuthSecret(environment.NEXTAUTH_SECRET),
    developerTermsVersion: partnerDeveloperTermsVersion(environment, production),
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
