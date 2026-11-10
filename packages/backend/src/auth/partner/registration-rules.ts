import { BOARD_TYPE_LABELS } from '@boardsesh/board-constants';

/**
 * The rules a developer's app must meet before Boardsesh registers it. Pure:
 * no Better Auth, no database, nothing built at import, so the GraphQL entry
 * point can load it with partner OAuth off. `registration.ts` applies them;
 * docs/integration-platform.md "Self-service registration" is the contract.
 */

export const PARTNER_APPS_PER_DEVELOPER = 10;
export const PARTNER_REDIRECT_URIS_PER_APP = 10;

/** Decision 22's launch caps, written to every new app's `oauth_app_policy` row. */
export const PARTNER_LAUNCH_MAX_ACTIVE_CONNECTIONS = 25;
export const PARTNER_LAUNCH_MAX_NEW_CONNECTIONS_PER_DAY = 20;

const NAME_MIN_LENGTH = 3;
const NAME_MAX_LENGTH = 50;
const URL_MAX_LENGTH = 2048;
const ALLOWLIST_ID_MAX_LENGTH = 128;

export const PARTNER_APP_APPLICATION_TYPES = ['web', 'native'] as const;
export type PartnerAppApplicationType = (typeof PARTNER_APP_APPLICATION_TYPES)[number];

/**
 * `docs/partner-api.md` section 2: confidential apps send their secret by Basic
 * or in the form, public apps send none. `private_key_jwt` is never offered: its
 * `jwks_uri` would be fetched inside the token transaction.
 */
export const PARTNER_APP_AUTH_METHODS = ['none', 'client_secret_basic', 'client_secret_post'] as const;
export type PartnerAppAuthMethod = (typeof PARTNER_APP_AUTH_METHODS)[number];

export interface PartnerAppInput {
  name: string;
  /** Who makes the app: "Made by" on the consent screen. Never the developer's account name. */
  publisherName: string;
  homepageUrl: string | null;
  privacyPolicyUrl: string;
  applicationType: PartnerAppApplicationType;
  tokenEndpointAuthMethod: PartnerAppAuthMethod;
  redirectUris: string[];
  /** The developer terms version the developer accepted: always the current one once validated. */
  acceptedTermsVersion: string;
}

/** An edit. A field left undefined keeps its value; `homepageUrl: null` clears it. */
export interface PartnerAppPatch {
  name?: string;
  publisherName?: string;
  homepageUrl?: string | null;
  privacyPolicyUrl?: string;
  redirectUris?: string[];
}

/** What a developer sees of one app. Never a secret. */
export interface PartnerAppRecord {
  clientId: string;
  name: string;
  /** Null only for an app registered before publishers were recorded. */
  publisherName: string | null;
  homepageUrl: string | null;
  privacyPolicyUrl: string;
  applicationType: PartnerAppApplicationType;
  tokenEndpointAuthMethod: PartnerAppAuthMethod;
  redirectUris: string[];
  createdAt: Date;
  suspendedAt: Date | null;
  suspensionReason: string | null;
  maxActiveConnections: number;
  maxNewConnectionsPerDay: number;
  /** Climbers connected now: the app redeemed a code and nobody has ended it. Deleting the app ends these. */
  activeConnections: number;
}

/** A new or rotated secret, returned once and never readable again. Null for a public app. */
export interface PartnerAppCredentials {
  app: PartnerAppRecord;
  clientSecret: string | null;
}

export type PartnerRegistrationRefusal =
  | 'invalid_input'
  | 'email_not_verified'
  | 'app_limit_reached'
  | 'not_found'
  | 'suspended'
  | 'no_secret'
  | 'terms_unpublished'
  | 'busy';

/** A refusal the developer can act on. The message is safe to show them. */
export class PartnerRegistrationError extends Error {
  constructor(
    readonly reason: PartnerRegistrationRefusal,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'PartnerRegistrationError';
  }
}

function invalid(message: string): never {
  throw new PartnerRegistrationError('invalid_input', message);
}

const CONTROL_OR_FORMAT_CHARACTER = /[\p{Cc}\p{Cf}]/u;

/** A boardsesh.com host, with or without subdomains and a trailing dot. */
function isBoardseshHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.+$/, '');
  return host === 'boardsesh.com' || host.endsWith('.boardsesh.com');
}

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.+$/, '');
  return host === 'localhost' || host.endsWith('.localhost') || host.startsWith('127.') || host === '[::1]';
}

/** The only hosts an `http:` redirect may name: RFC 8252 section 7.3 loopback literals. */
const LOOPBACK_HTTP_HOSTS: ReadonlySet<string> = new Set(['127.0.0.1', '[::1]']);

/** RFC 8252 section 7.1: a reverse-domain scheme, so it has at least one dot. Lower case, as URL writes it. */
const PRIVATE_USE_SCHEME = /^[a-z][a-z0-9-]*(?:\.[a-z0-9][a-z0-9-]*)+$/;

/**
 * Why a redirect URI cannot be registered for this kind of app, or null when it can.
 *
 * Allowed, and matched as exact strings (only a loopback port may differ):
 * - `https://` on any host but `boardsesh.com` and its subdomains, and never a
 *   loopback host. Web and native apps.
 * - `http://127.0.0.1` or `http://[::1]`, any port or none. Native apps only.
 * - A private-use scheme with a dot, such as `com.example.app:/oauth/boardsesh`
 *   or `com.example.app://host/path`, whose scheme does not contain `boardsesh`.
 *   Native apps only.
 *
 * Every URI must be written exactly as a URL parser writes it back, so what is
 * stored is what an exact comparison will see. No fragment (not even an empty
 * `#`), no wildcard `*`, no user name or password, no whitespace or control
 * characters, at most 2048 characters.
 */
export function partnerRedirectUriProblem(uri: string, applicationType: PartnerAppApplicationType): string | null {
  if (uri.length === 0 || uri.length > URL_MAX_LENGTH)
    return `A redirect URI must be 1 to ${URL_MAX_LENGTH} characters.`;
  if (/\s/.test(uri) || CONTROL_OR_FORMAT_CHARACTER.test(uri))
    return 'A redirect URI cannot contain spaces or control characters.';
  if (uri.includes('#')) return 'A redirect URI cannot have a fragment (#).';
  if (uri.includes('*')) return 'A redirect URI cannot contain a wildcard (*).';
  if (!URL.canParse(uri)) return `${uri} is not an absolute URI.`;
  const parsed = new URL(uri);
  if (parsed.href !== uri) return `Write this redirect URI as ${parsed.href}`;
  if (parsed.username || parsed.password) return 'A redirect URI cannot carry a user name or password.';

  if (parsed.protocol === 'https:') {
    if (isBoardseshHost(parsed.hostname)) return 'A redirect URI cannot point at boardsesh.com.';
    if (isLoopbackHost(parsed.hostname)) return 'A loopback redirect URI must use http://127.0.0.1 or http://[::1].';
    return null;
  }

  if (parsed.protocol === 'http:') {
    if (applicationType !== 'native') return 'A web app can only use https:// redirect URIs.';
    if (!LOOPBACK_HTTP_HOSTS.has(parsed.hostname))
      return 'http:// is only allowed on the loopback addresses 127.0.0.1 and [::1].';
    return null;
  }

  if (applicationType !== 'native') return 'A web app can only use https:// redirect URIs.';
  const scheme = parsed.protocol.slice(0, -1);
  if (!PRIVATE_USE_SCHEME.test(scheme))
    return 'A custom scheme must be a reverse domain name with a dot, such as com.example.app.';
  if (scheme.includes('boardsesh')) return 'A redirect URI cannot use a Boardsesh scheme.';
  const afterScheme = uri.slice(parsed.protocol.length);
  const authorityFree = afterScheme.startsWith('/') && !afterScheme.startsWith('//');
  const withHostAndPath = parsed.host.length > 0 && parsed.pathname.startsWith('/');
  if (!authorityFree && !withHostAndPath)
    return 'A custom-scheme redirect URI needs a path, such as com.example.app:/oauth/boardsesh.';
  return null;
}

export function validatePartnerRedirectUris(
  redirectUris: unknown,
  applicationType: PartnerAppApplicationType,
): string[] {
  if (!Array.isArray(redirectUris) || !redirectUris.every((uri): uri is string => typeof uri === 'string')) {
    invalid('Redirect URIs must be a list of strings.');
  }
  if (redirectUris.length === 0) invalid('Add at least one redirect URI.');
  if (redirectUris.length > PARTNER_REDIRECT_URIS_PER_APP) {
    invalid(`An app can have at most ${PARTNER_REDIRECT_URIS_PER_APP} redirect URIs.`);
  }
  if (new Set(redirectUris).size !== redirectUris.length) invalid('A redirect URI is listed twice.');
  for (const uri of redirectUris) {
    const problem = partnerRedirectUriProblem(uri, applicationType);
    if (problem) invalid(problem);
  }
  return [...redirectUris];
}

/** Lookalike letters folded together, so `B0ardsesh` and `K1lter` read as the names they imitate. */
const CONFUSABLE_LETTERS: Readonly<Record<string, string>> = {
  '0': 'o',
  '1': 'l',
  '3': 'e',
  '4': 'a',
  '5': 's',
  '7': 't',
  '8': 'b',
  $: 's',
  '@': 'a',
  '!': 'l',
  '|': 'l',
  i: 'l',
  // Cyrillic and Greek letters that render like Latin ones.
  а: 'a',
  в: 'b',
  е: 'e',
  к: 'k',
  м: 'm',
  н: 'h',
  о: 'o',
  р: 'p',
  с: 'c',
  т: 't',
  у: 'y',
  х: 'x',
  і: 'l',
  ѕ: 's',
  ԁ: 'd',
  α: 'a',
  ο: 'o',
  ρ: 'p',
  ν: 'v',
  τ: 't',
  // Latin-script letters outside a-z that read as a-z: dotless and small-capital
  // i, Latin alpha, small-capital B and K. A mixed-script check cannot see these.
  ı: 'l',
  ɪ: 'l',
  ɑ: 'a',
  ʙ: 'b',
  ᴋ: 'k',
};

const LATIN_LETTER = /\p{Script=Latin}/u;
/** Scripts with letters that render like Latin ones. A name may use them, but not alongside Latin. */
const LATIN_LOOKALIKE_SCRIPT = /[\p{Script=Greek}\p{Script=Cyrillic}\p{Script=Armenian}\p{Script=Cherokee}]/u;

/** Case, accents, spacing, punctuation and lookalike letters removed. */
function nameSkeleton(name: string): string {
  const folded = name
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/./gsu, (character) => CONFUSABLE_LETTERS[character] ?? character)
    .replace(/[^a-z]/g, '');
  return folded.replace(/rn/g, 'm').replace(/vv/g, 'w');
}

/**
 * Names an app or its publisher may not use or imitate: Boardsesh, Aurora, the
 * MoonBoard's maker, and every board brand in BOARD_TYPE_LABELS. The other
 * makers trade under their board's brand, so the brand covers them. "Spray wall"
 * is a kind of wall, not a brand.
 */
export const PARTNER_APP_NAME_DENYLIST: readonly string[] = [
  'Boardsesh',
  'Aurora',
  'Moon Climbing',
  ...Object.entries(BOARD_TYPE_LABELS)
    .filter(([boardType]) => boardType !== 'spray')
    .map(([, label]) => label),
];

const DENIED_NAME_SKELETONS = PARTNER_APP_NAME_DENYLIST.map((term) => ({ term, skeleton: nameSkeleton(term) }));

/**
 * A name climbers read on the consent screen, cleaned, or a refusal: 3 to 50
 * characters after trimming and collapsing spaces, at least one letter or
 * number, no control characters, nothing that contains a denied term, however
 * disguised, and no Latin letters mixed with Greek, Cyrillic, Armenian or
 * Cherokee ones. The skeleton only folds the lookalikes it lists and drops
 * every other letter outside a-z, so "Κilter" (Greek Κ) would reach the
 * denylist as "lter"; refusing the mix closes that whole class. A name written
 * entirely in one of those scripts is fine.
 */
function validateConsentScreenName(rawName: unknown, field: string, missing: string): string {
  if (typeof rawName !== 'string') invalid(missing);
  if (CONTROL_OR_FORMAT_CHARACTER.test(rawName)) invalid(`The ${field} cannot contain control characters.`);
  const name = rawName.normalize('NFKC').trim().replace(/\s+/g, ' ');
  if (name.length < NAME_MIN_LENGTH || name.length > NAME_MAX_LENGTH) {
    invalid(`The ${field} must be ${NAME_MIN_LENGTH} to ${NAME_MAX_LENGTH} characters.`);
  }
  if (!/[\p{L}\p{N}]/u.test(name)) invalid(`The ${field} needs at least one letter or number.`);
  const skeleton = nameSkeleton(name);
  const denied = DENIED_NAME_SKELETONS.find((entry) => skeleton.includes(entry.skeleton));
  if (denied) invalid(`The ${field} cannot use or imitate "${denied.term}".`);
  if (LATIN_LETTER.test(name) && LATIN_LOOKALIKE_SCRIPT.test(name)) {
    invalid(`The ${field} cannot mix Latin letters with Greek, Cyrillic, Armenian or Cherokee ones.`);
  }
  return name;
}

export function validatePartnerAppName(rawName: unknown): string {
  return validateConsentScreenName(rawName, 'app name', 'Give the app a name.');
}

/**
 * The person or company that makes the app, shown as "Made by". Public, so it
 * follows the app-name rules: a publisher cannot pass as Boardsesh or a board maker.
 */
export function validatePartnerPublisherName(rawName: unknown): string {
  return validateConsentScreenName(rawName, 'publisher name', 'Say who makes the app: a person or a company.');
}

/** A link shown on the consent screen: https, no credentials, not on boardsesh.com. Returned as the parser writes it. */
export function validatePartnerAppLink(rawUrl: unknown, label: string): string {
  if (typeof rawUrl !== 'string' || rawUrl.length === 0 || rawUrl.length > URL_MAX_LENGTH) {
    invalid(`The ${label} must be a URL of 1 to ${URL_MAX_LENGTH} characters.`);
  }
  if (/\s/.test(rawUrl) || CONTROL_OR_FORMAT_CHARACTER.test(rawUrl) || !URL.canParse(rawUrl)) {
    invalid(`The ${label} is not a valid URL.`);
  }
  const parsed = new URL(rawUrl);
  if (parsed.protocol !== 'https:') invalid(`The ${label} must start with https://.`);
  if (parsed.username || parsed.password) invalid(`The ${label} cannot carry a user name or password.`);
  if (isBoardseshHost(parsed.hostname)) invalid(`The ${label} cannot point at boardsesh.com.`);
  return parsed.href;
}

function validateApplicationType(rawType: unknown): PartnerAppApplicationType {
  const match = PARTNER_APP_APPLICATION_TYPES.find((type) => type === rawType);
  if (!match) invalid('Choose web or native for the app type.');
  return match;
}

function validateAuthMethod(rawMethod: unknown): PartnerAppAuthMethod {
  const match = PARTNER_APP_AUTH_METHODS.find((method) => method === rawMethod);
  if (!match) invalid('Choose none, client_secret_basic or client_secret_post for the token endpoint.');
  return match;
}

/** Terms the owner has not approved yet. No app registers against them. */
export function isDraftDeveloperTermsVersion(termsVersion: string): boolean {
  return termsVersion.endsWith('-draft');
}

/**
 * A new app needs the developer to have accepted the terms the console shows
 * now. An older version is refused too, so a console left open across a terms
 * change asks again instead of recording text the developer never saw.
 */
function validateAcceptedTermsVersion(raw: unknown, termsVersion: string): string {
  if (raw !== termsVersion) {
    invalid('Accept the current Boardsesh developer terms to register an app. Reload the page to see them.');
  }
  return termsVersion;
}

/**
 * `termsVersion` is the deployment's current developer terms. While they are a
 * draft, every registration is refused before anything else is checked.
 */
export function normalizePartnerAppInput(raw: Record<string, unknown>, termsVersion: string): PartnerAppInput {
  if (isDraftDeveloperTermsVersion(termsVersion)) {
    throw new PartnerRegistrationError(
      'terms_unpublished',
      'Developer terms are not published yet, so no app can be registered. Registration opens once Boardsesh publishes them.',
    );
  }
  const applicationType = validateApplicationType(raw.applicationType);
  return {
    name: validatePartnerAppName(raw.name),
    publisherName: validatePartnerPublisherName(raw.publisherName),
    homepageUrl:
      raw.homepageUrl === undefined || raw.homepageUrl === null || raw.homepageUrl === ''
        ? null
        : validatePartnerAppLink(raw.homepageUrl, 'homepage URL'),
    privacyPolicyUrl: validatePartnerAppLink(raw.privacyPolicyUrl, 'privacy policy URL'),
    applicationType,
    tokenEndpointAuthMethod: validateAuthMethod(raw.tokenEndpointAuthMethod),
    redirectUris: validatePartnerRedirectUris(raw.redirectUris, applicationType),
    acceptedTermsVersion: validateAcceptedTermsVersion(raw.acceptedTermsVersion, termsVersion),
  };
}

/** Validates an edit against the app's stored type, which never changes. */
export function normalizePartnerAppPatch(
  raw: Record<string, unknown>,
  applicationType: PartnerAppApplicationType,
): PartnerAppPatch {
  const patch: PartnerAppPatch = {};
  if (raw.name !== undefined && raw.name !== null) patch.name = validatePartnerAppName(raw.name);
  // Required at registration, so an edit can change it but never clear it.
  if (raw.publisherName !== undefined && raw.publisherName !== null) {
    patch.publisherName = validatePartnerPublisherName(raw.publisherName);
  }
  if (raw.homepageUrl !== undefined) {
    patch.homepageUrl =
      raw.homepageUrl === null || raw.homepageUrl === ''
        ? null
        : validatePartnerAppLink(raw.homepageUrl, 'homepage URL');
  }
  if (raw.privacyPolicyUrl !== undefined && raw.privacyPolicyUrl !== null) {
    patch.privacyPolicyUrl = validatePartnerAppLink(raw.privacyPolicyUrl, 'privacy policy URL');
  }
  if (raw.redirectUris !== undefined && raw.redirectUris !== null) {
    patch.redirectUris = validatePartnerRedirectUris(raw.redirectUris, applicationType);
  }
  if (Object.keys(patch).length === 0) invalid('Change at least one field.');
  return patch;
}

/**
 * `PARTNER_OAUTH_DEVELOPER_ALLOWLIST`: comma-separated Boardsesh user ids. Unset
 * or empty means nobody may register, so a missing variable fails closed.
 */
export function parsePartnerDeveloperAllowlist(rawAllowlist: string | undefined): ReadonlySet<string> {
  const ids = (rawAllowlist ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id.length > 0 && id.length <= ALLOWLIST_ID_MAX_LENGTH && !/\s/.test(id));
  return new Set(ids);
}
