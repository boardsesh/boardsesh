import { FEATURE_FLAG_OVERRIDES_ENV, parseFeatureFlagOverrides } from '@boardsesh/analytics';
import { PARTNER_DEVELOPER_CONSOLE_FLAG } from '@boardsesh/auth-protocol/partner-oauth';
import { isPrivateDatabaseTarget } from '@boardsesh/db/client/config';
import { logger } from '../../utils/logger';

/**
 * Who may use the developer console (list, register, edit, rotate, delete):
 * the PostHog flag `developer-console`, the same flag that shows www
 * `/developers/apps`, asked for the account's `users.id`. Inviting a developer
 * is one PostHog edit, with nothing to deploy.
 *
 * Only the console asks. The OAuth routes and `/v1` never do, so an app keeps
 * working after its developer leaves the flag; the developer just cannot
 * manage it until they are back in.
 *
 * "Not production" below means provably so: `DATABASE_URL` names this machine,
 * a container or a private network (`isPrivateDatabaseTarget`, the check that
 * also keeps a laptop out of production Sentry). That covers tests, CI, the
 * e2e journey and `vp run dev`. A label such as `SENTRY_ENVIRONMENT` or
 * `NODE_ENV` is not enough: a production deploy with a wrong label would then
 * open the console to every account.
 *
 * In order:
 *
 * 1. `FEATURE_FLAG_OVERRIDES`, in www's syntax, when it names the flag.
 *    `developer-console=false` refuses everyone, everywhere: www uses it as a
 *    kill switch, so the operations close with the page. `developer-console`
 *    (on) lets every account in, but only when this process is not production;
 *    tests, the e2e journey and a laptop use it instead of PostHog. Anywhere
 *    else it is ignored and logged once, and PostHog decides.
 * 2. No PostHog key. Outside production that is normal, so the answer is no.
 *    Anywhere else it is a broken deploy, so the answer is "could not check".
 * 3. A PostHog answer for this account from the last 60 seconds. Both yes and
 *    no are kept, per replica; failures are not.
 * 4. `POST {POSTHOG_HOST}/flags/?v=2` for this one flag, under a 1.5 s
 *    deadline, over https (plain http only to this machine), following no
 *    redirect. Only the account id travels, as the distinct id and as the
 *    `distinct_id` person property, so a `distinct_id` someone stored on their
 *    own person cannot match the flag for them. No email, no other person
 *    data, no GeoIP. A flags request creates no PostHog person and no
 *    `$feature_flag_called` event (those come from the SDKs, not the endpoint).
 *    Target the flag by `distinct_id` only: anyone holding the public project
 *    token can set other person properties, such as an email, on their own
 *    person.
 * 5. Anything else, such as a timeout, a redirect, a non-2xx, an unreadable
 *    body, a quota limit, the flag missing or failing to compute, means "could
 *    not check".
 *
 * Fails closed. Only an override or PostHog naming this account lets it in.
 * "Could not check" keeps the console shut as well; the console says so
 * instead of calling the developer uninvited, since nobody refused them.
 *
 * Call it before any transaction: the request can take up to the deadline.
 */

export type PartnerDeveloperAccessReason =
  /** `FEATURE_FLAG_OVERRIDES` decided it: a refusal anywhere, a yes only outside production. */
  | 'override'
  /** No `POSTHOG_PROJECT_KEY` or `NEXT_PUBLIC_POSTHOG_KEY`. */
  | 'no-api-key'
  /** `POSTHOG_HOST` is not https (plain http is allowed only to this machine) or not a URL. */
  | 'invalid-host'
  /** PostHog evaluated the flag and this account is in it. */
  | 'posthog-enabled'
  /** PostHog evaluated the flag and this account is not in it. */
  | 'posthog-disabled'
  /** 200, but the flag is not in the answer: renamed, deleted, or a key for another project. */
  | 'flag-missing'
  /** PostHog says it failed to compute the flag. */
  | 'flag-errored'
  /** PostHog stopped serving flags for the project (billing). */
  | 'quota-limited'
  /** PostHog answered non-2xx. */
  | 'http-error'
  /** The request threw, timed out, or came back unreadable. */
  | 'request-failed';

export interface PartnerDeveloperAccess {
  /** Only `allowed` opens the console. `unavailable` means PostHog gave no usable answer. */
  decision: 'allowed' | 'refused' | 'unavailable';
  reason: PartnerDeveloperAccessReason;
  /** The status for `http-error`, the error name for `request-failed`, the products for `quota-limited`. */
  detail: string | null;
}

/** `process.env`, or a plain object in tests. */
type Environment = Record<string, string | undefined>;

export interface PartnerDeveloperAccessOptions {
  environment?: Environment;
  /**
   * True only when this process provably cannot be production. Defaults to
   * `isPrivateDatabaseTarget()`; tests pass it to skip that wiring.
   */
  notProduction?: boolean;
}

/** PostHog's US host, the default the backend's analytics client and www use. */
const DEFAULT_POSTHOG_HOST = 'https://us.i.posthog.com';
/** The same pair, in the same order, as `services/analytics/posthog.ts` and www. */
const API_KEY_ENV_NAMES = ['POSTHOG_PROJECT_KEY', 'NEXT_PUBLIC_POSTHOG_KEY'] as const;
/** www's deadline for the same question. A console request waits at most this long for PostHog. */
export const PARTNER_DEVELOPER_ACCESS_TIMEOUT_MS = 1_500;
/** www caches the same answer for 60 s, so a flag change reaches both within a minute. */
export const PARTNER_DEVELOPER_ACCESS_CACHE_MS = 60_000;
/** Any signed-in account can ask, so the cache has a ceiling. The oldest answer goes first. */
const CACHE_MAX_ENTRIES = 1_000;
/** Hosts a flag request may reach over plain http: this machine (tests, a local stand-in). */
const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);

const answers = new Map<string, { enabled: boolean; expiresAt: number }>();
let outageLogged = false;
let ignoredOverrideLogged = false;

function readVariable(environment: Environment, name: string): string | null {
  const value = environment[name]?.trim();
  return value ? value : null;
}

function readApiKey(environment: Environment): string | null {
  for (const name of API_KEY_ENV_NAMES) {
    const key = readVariable(environment, name);
    if (key) return key;
  }
  return null;
}

/** The flags endpoint on `POSTHOG_HOST`, or null when the host is not https and not this machine. */
function flagsUrl(environment: Environment): URL | null {
  const host = readVariable(environment, 'POSTHOG_HOST') ?? DEFAULT_POSTHOG_HOST;
  let url: URL;
  try {
    url = new URL(`${host.replace(/\/+$/, '')}/flags/?v=2`);
  } catch {
    return null;
  }
  if (url.protocol === 'https:') return url;
  return url.protocol === 'http:' && LOOPBACK_HOSTNAMES.has(url.hostname) ? url : null;
}

function decisionFor(reason: PartnerDeveloperAccessReason, detail: string | null = null): PartnerDeveloperAccess {
  if (reason === 'posthog-enabled') return { decision: 'allowed', reason, detail };
  if (reason === 'posthog-disabled') return { decision: 'refused', reason, detail };
  return { decision: 'unavailable', reason, detail };
}

/**
 * One error per outage, not per request: an outage fails every console call.
 * An answer from PostHog re-arms it, so a second outage is reported too.
 */
function noteOutcome(access: PartnerDeveloperAccess): PartnerDeveloperAccess {
  if (access.decision !== 'unavailable') {
    outageLogged = false;
    return access;
  }
  if (outageLogged) return access;
  outageLogged = true;
  const detail = access.detail ? `${access.reason}: ${access.detail}` : access.reason;
  logger.error('[PartnerDeveloperAccess] Could not check the developer-console flag; the console is shut', {
    reason: access.reason,
    detail: access.detail,
    error: new Error(`developer-console flag could not be evaluated (${detail})`),
  });
  return access;
}

type PosthogFlagsResponse = {
  flags?: Record<string, { enabled?: unknown; failed?: unknown } | undefined>;
  featureFlags?: Record<string, unknown>;
  errorsWhileComputingFlags?: unknown;
  quotaLimited?: unknown;
};

/** The same reading as www's `readFlagResolution`, plus PostHog's own "failed to compute". */
function readAnswer(payload: unknown): PartnerDeveloperAccess {
  if (!payload || typeof payload !== 'object') return decisionFor('request-failed', 'unreadable body');
  const { flags, featureFlags, errorsWhileComputingFlags, quotaLimited } = payload as PosthogFlagsResponse;
  const detail = flags?.[PARTNER_DEVELOPER_CONSOLE_FLAG];
  let enabled: boolean | undefined;
  if (detail && typeof detail.enabled === 'boolean') {
    enabled = detail.enabled;
  } else {
    const legacy = featureFlags?.[PARTNER_DEVELOPER_CONSOLE_FLAG];
    if (typeof legacy === 'boolean') enabled = legacy;
    // A variant name means the account is in the flag.
    else if (typeof legacy === 'string' && legacy.length > 0) enabled = true;
  }
  if (enabled === true) return decisionFor('posthog-enabled');
  // A `false` PostHog could not compute is not a refusal.
  if (errorsWhileComputingFlags === true || detail?.failed === true) return decisionFor('flag-errored');
  if (enabled === false) return decisionFor('posthog-disabled');
  const limited = Array.isArray(quotaLimited)
    ? quotaLimited.filter((product): product is string => typeof product === 'string' && product.trim().length > 0)
    : [];
  if (limited.length > 0) return decisionFor('quota-limited', limited.join(', '));
  return decisionFor('flag-missing');
}

async function askPosthog(userId: string, apiKey: string, url: URL): Promise<PartnerDeveloperAccess> {
  const controller = new AbortController();
  // Covers the body as well as the headers: the timer is cleared only after parsing.
  const timer = setTimeout(() => controller.abort(), PARTNER_DEVELOPER_ACCESS_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token: apiKey,
        distinct_id: userId,
        // A property sent with the request beats one stored on the person, so a
        // `distinct_id` property someone set on their own person cannot match.
        person_properties: { distinct_id: userId },
        flag_keys_to_evaluate: [PARTNER_DEVELOPER_CONSOLE_FLAG],
        geoip_disable: true,
      }),
      // A redirect could carry the project token somewhere else.
      redirect: 'error',
      signal: controller.signal,
    });
    if (!response.ok) return decisionFor('http-error', String(response.status));
    return readAnswer(await response.json());
  } catch (error) {
    return decisionFor('request-failed', error instanceof Error ? error.name : 'unknown error');
  } finally {
    clearTimeout(timer);
  }
}

function remember(userId: string, enabled: boolean): void {
  answers.delete(userId);
  if (answers.size >= CACHE_MAX_ENTRIES) {
    const oldest = answers.keys().next().value;
    if (oldest !== undefined) answers.delete(oldest);
  }
  answers.set(userId, { enabled, expiresAt: Date.now() + PARTNER_DEVELOPER_ACCESS_CACHE_MS });
}

/** Whether `userId` may use the developer console. Never throws. */
export async function checkPartnerDeveloperAccess(
  userId: string,
  { environment = process.env, notProduction = isPrivateDatabaseTarget() }: PartnerDeveloperAccessOptions = {},
): Promise<PartnerDeveloperAccess> {
  const override = parseFeatureFlagOverrides(environment[FEATURE_FLAG_OVERRIDES_ENV])[PARTNER_DEVELOPER_CONSOLE_FLAG];
  // A refusal is safe anywhere, and it is www's kill switch for the same pages.
  if (override === false) return { decision: 'refused', reason: 'override', detail: null };
  if (override === true) {
    if (notProduction) return { decision: 'allowed', reason: 'override', detail: null };
    if (!ignoredOverrideLogged) {
      ignoredOverrideLogged = true;
      logger.warn(
        `[PartnerDeveloperAccess] ${FEATURE_FLAG_OVERRIDES_ENV} turns ${PARTNER_DEVELOPER_CONSOLE_FLAG} on, but this process may be production; ignoring it and asking PostHog`,
      );
    }
  }

  const apiKey = readApiKey(environment);
  if (!apiKey) {
    const missing = decisionFor('no-api-key');
    return notProduction ? { ...missing, decision: 'refused' } : noteOutcome(missing);
  }

  const cached = answers.get(userId);
  if (cached && cached.expiresAt > Date.now()) {
    return decisionFor(cached.enabled ? 'posthog-enabled' : 'posthog-disabled');
  }

  const url = flagsUrl(environment);
  if (!url) return noteOutcome(decisionFor('invalid-host'));
  const access = await askPosthog(userId, apiKey, url);
  if (access.decision !== 'unavailable') remember(userId, access.decision === 'allowed');
  return noteOutcome(access);
}

export function __resetPartnerDeveloperAccessForTests(): void {
  answers.clear();
  outageLogged = false;
  ignoredOverrideLogged = false;
}
