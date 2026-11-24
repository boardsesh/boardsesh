import { FEATURE_FLAG_OVERRIDES_ENV, parseFeatureFlagOverrides } from '@boardsesh/analytics';
import { logger } from '../utils/logger';

/**
 * A server flag that is one switch for the whole service, not a per-account
 * rollout: PostHog evaluates it for the fixed id `system:<flag>`. The
 * `directory-reports` and `directory-setup-suggestions` flags are built on it
 * (docs/product/directory-reports.md, docs/operations/feature-flags.md).
 *
 * In order:
 *
 * 1. `FEATURE_FLAG_OVERRIDES` naming the flag decides, on or off, in every
 *    environment. `<flag>` turns it on (tests, a laptop, the lever for
 *    production); `<flag>=false` is the kill switch.
 * 2. No PostHog project key: off.
 * 3. PostHog's answer for the fixed id `system:<flag>`, kept 60 s. Turn the
 *    flag on with a plain 100% release condition: a condition on a person
 *    property or a cohort never matches this id. An answer that leaves the
 *    flag out (it was deleted, or never created) is off.
 * 4. No answer (timeout, non-2xx, unreadable body, PostHog reporting errors
 *    while it evaluated): the last answer stands for one more interval (60 s),
 *    so one slow request does not flap the flag; after that, off until PostHog
 *    answers again. With no last answer, off.
 *
 * Fails closed. The answer is read in two ways: `isEnabled()` awaits a fresh
 * answer when the cached one is stale, and `enabledNow()` reads the cached
 * answer without waiting (inside a transaction that holds row locks, where a
 * PostHog round trip must not run).
 */

const DEFAULT_POSTHOG_HOST = 'https://us.i.posthog.com';
const API_KEY_ENV_NAMES = ['POSTHOG_PROJECT_KEY', 'NEXT_PUBLIC_POSTHOG_KEY'] as const;
const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);
const FLAG_TIMEOUT_MS = 1_500;
export const SYSTEM_SERVER_FLAG_CACHE_MS = 60_000;

export type FlagEnvironment = Record<string, string | undefined>;

export type SystemServerFlag = {
  /** The PostHog flag key. */
  key: string;
  /** True or false when PostHog answered for the flag, false when its answer leaves the flag out, null when unusable. */
  readAnswer: (payload: unknown) => boolean | null;
  /** Whether the flag is on. Awaits PostHog (at most 1.5 s) when the cached answer is stale. Never throws. */
  isEnabled: (environment?: FlagEnvironment) => Promise<boolean>;
  /**
   * Whether the flag is on, from the override or the cached answer, without
   * waiting. Safe inside a transaction. A stale cache starts a refresh in the
   * background and answers with what it has (off when it has nothing).
   */
  enabledNow: (environment?: FlagEnvironment) => boolean;
  /** Read the first answer (at most 1.5 s) and keep it fresh. Returns the stop function. */
  startRefresh: () => Promise<() => void>;
  resetForTests: () => void;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

type PosthogFlagsResponse = {
  flags?: Record<string, { enabled?: unknown } | undefined>;
  featureFlags?: Record<string, unknown>;
  errorsWhileComputingFlags?: unknown;
};

function readApiKey(environment: FlagEnvironment): string | null {
  for (const name of API_KEY_ENV_NAMES) {
    const apiKey = environment[name]?.trim();
    if (apiKey) return apiKey;
  }
  return null;
}

function flagsUrl(environment: FlagEnvironment): URL | null {
  const host = environment.POSTHOG_HOST?.trim() || DEFAULT_POSTHOG_HOST;
  let url: URL;
  try {
    url = new URL(`${host.replace(/\/+$/, '')}/flags/?v=2`);
  } catch {
    return null;
  }
  if (url.protocol === 'https:') return url;
  return url.protocol === 'http:' && LOOPBACK_HOSTNAMES.has(url.hostname) ? url : null;
}

/**
 * A system flag: one answer for the whole service, evaluated for
 * `system:<flagKey>`. `logLabel` prefixes the one outage warning, and
 * `outageConsequence` says what stays off while PostHog doesn't answer.
 */
export function createSystemServerFlag(options: {
  flagKey: string;
  logLabel: string;
  outageConsequence: string;
}): SystemServerFlag {
  const { flagKey } = options;
  const distinctId = `system:${flagKey}`;

  /**
   * The answer the reads use. `carried` marks the last answer kept through an
   * outage: it stands for one interval, and the next outage turns the flag off.
   */
  let cachedAnswer: { enabled: boolean; expiresAt: number; carried: boolean } | null = null;
  let refreshInFlight: Promise<boolean> | null = null;
  let outageLogged = false;

  function readOverride(environment: FlagEnvironment): boolean | undefined {
    return parseFeatureFlagOverrides(environment[FEATURE_FLAG_OVERRIDES_ENV])[flagKey];
  }

  function readAnswer(payload: unknown): boolean | null {
    if (!isRecord(payload)) return null;
    const { flags, featureFlags, errorsWhileComputingFlags } = payload as PosthogFlagsResponse;
    const detail = flags?.[flagKey];
    if (detail && typeof detail.enabled === 'boolean') return detail.enabled;
    const legacy = featureFlags?.[flagKey];
    if (typeof legacy === 'boolean') return legacy;
    if (typeof legacy === 'string') return legacy.length > 0;
    if (errorsWhileComputingFlags === true) return null;
    // A well-formed answer without the flag: it does not exist, so it is off.
    return isRecord(flags) || isRecord(featureFlags) ? false : null;
  }

  async function askPosthog(apiKey: string, url: URL): Promise<boolean | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FLAG_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token: apiKey,
          distinct_id: distinctId,
          flag_keys_to_evaluate: [flagKey],
          geoip_disable: true,
        }),
        redirect: 'error',
        signal: controller.signal,
      });
      if (!response.ok) return null;
      return readAnswer(await response.json());
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  async function refresh(environment: FlagEnvironment): Promise<boolean> {
    const apiKey = readApiKey(environment);
    const url = flagsUrl(environment);
    const answer = apiKey && url ? await askPosthog(apiKey, url) : false;
    if (answer === null) {
      if (!outageLogged) {
        outageLogged = true;
        logger.warn(`[${options.logLabel}] Could not read the ${flagKey} flag; ${options.outageConsequence}`);
      }
      // Keep a real answer for one more interval rather than flapping off on one
      // slow request. An answer already carried once, or none at all: off.
      const carryOver = cachedAnswer !== null && !cachedAnswer.carried && cachedAnswer.enabled;
      cachedAnswer = { enabled: carryOver, expiresAt: Date.now() + SYSTEM_SERVER_FLAG_CACHE_MS, carried: true };
      return carryOver;
    }
    outageLogged = false;
    cachedAnswer = { enabled: answer, expiresAt: Date.now() + SYSTEM_SERVER_FLAG_CACHE_MS, carried: false };
    return answer;
  }

  function refreshOnce(environment: FlagEnvironment): Promise<boolean> {
    if (!refreshInFlight) {
      refreshInFlight = refresh(environment).finally(() => {
        refreshInFlight = null;
      });
    }
    return refreshInFlight;
  }

  async function isEnabled(environment: FlagEnvironment = process.env): Promise<boolean> {
    const override = readOverride(environment);
    if (override !== undefined) return override;
    if (cachedAnswer && cachedAnswer.expiresAt > Date.now()) return cachedAnswer.enabled;
    return refreshOnce(environment);
  }

  function enabledNow(environment: FlagEnvironment = process.env): boolean {
    const override = readOverride(environment);
    if (override !== undefined) return override;
    if (!cachedAnswer || cachedAnswer.expiresAt <= Date.now()) {
      void refreshOnce(environment);
    }
    return cachedAnswer?.enabled ?? false;
  }

  async function startRefresh(): Promise<() => void> {
    await isEnabled();
    const interval = setInterval(() => {
      void isEnabled();
    }, SYSTEM_SERVER_FLAG_CACHE_MS / 2);
    interval.unref();
    return () => clearInterval(interval);
  }

  function resetForTests(): void {
    cachedAnswer = null;
    refreshInFlight = null;
    outageLogged = false;
  }

  return { key: flagKey, readAnswer, isEnabled, enabledNow, startRefresh, resetForTests };
}
