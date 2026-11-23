import { FEATURE_FLAG_OVERRIDES_ENV, parseFeatureFlagOverrides } from '@boardsesh/analytics';
import { logger } from '../utils/logger';

/**
 * The `directory-reports` server flag (docs/product/directory-reports.md,
 * docs/operations/feature-flags.md). It gates the report mutations and every
 * notification the reports feature sends, so no report notice reaches an app
 * build that cannot word it. It is one switch for the whole service, not a
 * per-account rollout: a report reaches people other than the reporter, and
 * the old app builds it must stay away from belong to them.
 *
 * In order:
 *
 * 1. `FEATURE_FLAG_OVERRIDES` naming the flag decides, on or off, in every
 *    environment. `directory-reports` turns it on (tests, a laptop, the lever
 *    for production); `directory-reports=false` is the kill switch.
 * 2. No PostHog project key: off.
 * 3. PostHog's answer for the fixed id `system:directory-reports`, kept 60 s.
 *    Turn the flag on with a plain 100% release condition: a condition on a
 *    person property or a cohort never matches this id. An answer that leaves
 *    the flag out (it was deleted, or never created) is off.
 * 4. No answer (timeout, non-2xx, unreadable body, PostHog reporting errors
 *    while it evaluated): the last answer stands for one more interval (60 s),
 *    so one slow request does not flap the flag; after that, off until PostHog
 *    answers again. With no last answer, off.
 *
 * Fails closed. The answer is read in two ways: `isDirectoryReportsEnabled()`
 * awaits a fresh answer when the cached one is stale (the report mutations, the
 * sweep, the push worker), and `directoryReportsEnabledNow()` reads the cached
 * answer without waiting (inside a transaction that holds row locks, where a
 * PostHog round trip must not run). Boot awaits the first answer before the
 * server and the workers start, and a background refresh keeps it warm.
 */

export const DIRECTORY_REPORTS_FLAG = 'directory-reports';

/** The fixed id PostHog evaluates the flag for. Not a person. */
const FLAG_DISTINCT_ID = 'system:directory-reports';
const DEFAULT_POSTHOG_HOST = 'https://us.i.posthog.com';
const API_KEY_ENV_NAMES = ['POSTHOG_PROJECT_KEY', 'NEXT_PUBLIC_POSTHOG_KEY'] as const;
const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);
const FLAG_TIMEOUT_MS = 1_500;
export const DIRECTORY_REPORTS_FLAG_CACHE_MS = 60_000;

type Environment = Record<string, string | undefined>;

/**
 * The answer the reads use. `carried` marks the last answer kept through an
 * outage: it stands for one interval, and the next outage turns the flag off.
 */
let cachedAnswer: { enabled: boolean; expiresAt: number; carried: boolean } | null = null;
let refreshInFlight: Promise<boolean> | null = null;
let outageLogged = false;

function readOverride(environment: Environment): boolean | undefined {
  return parseFeatureFlagOverrides(environment[FEATURE_FLAG_OVERRIDES_ENV])[DIRECTORY_REPORTS_FLAG];
}

function readApiKey(environment: Environment): string | null {
  for (const name of API_KEY_ENV_NAMES) {
    const key = environment[name]?.trim();
    if (key) return key;
  }
  return null;
}

function flagsUrl(environment: Environment): URL | null {
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

type PosthogFlagsResponse = {
  flags?: Record<string, { enabled?: unknown } | undefined>;
  featureFlags?: Record<string, unknown>;
  errorsWhileComputingFlags?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * True or false when PostHog answered for the flag, false when its answer
 * leaves the flag out, and null when it gave no usable answer: an unreadable
 * body, or one that says evaluating the flags went wrong.
 */
export function readDirectoryReportsFlagAnswer(payload: unknown): boolean | null {
  if (!isRecord(payload)) return null;
  const { flags, featureFlags, errorsWhileComputingFlags } = payload as PosthogFlagsResponse;
  const detail = flags?.[DIRECTORY_REPORTS_FLAG];
  if (detail && typeof detail.enabled === 'boolean') return detail.enabled;
  const legacy = featureFlags?.[DIRECTORY_REPORTS_FLAG];
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
        distinct_id: FLAG_DISTINCT_ID,
        flag_keys_to_evaluate: [DIRECTORY_REPORTS_FLAG],
        geoip_disable: true,
      }),
      redirect: 'error',
      signal: controller.signal,
    });
    if (!response.ok) return null;
    return readDirectoryReportsFlagAnswer(await response.json());
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function refresh(environment: Environment): Promise<boolean> {
  const apiKey = readApiKey(environment);
  const url = flagsUrl(environment);
  const answer = apiKey && url ? await askPosthog(apiKey, url) : false;
  if (answer === null) {
    if (!outageLogged) {
      outageLogged = true;
      logger.warn('[DirectoryReports] Could not read the directory-reports flag; reports stay off until it answers');
    }
    // Keep a real answer for one more interval rather than flapping off on one
    // slow request. An answer already carried once, or none at all: off.
    const carryOver = cachedAnswer !== null && !cachedAnswer.carried && cachedAnswer.enabled;
    cachedAnswer = { enabled: carryOver, expiresAt: Date.now() + DIRECTORY_REPORTS_FLAG_CACHE_MS, carried: true };
    return carryOver;
  }
  outageLogged = false;
  cachedAnswer = { enabled: answer, expiresAt: Date.now() + DIRECTORY_REPORTS_FLAG_CACHE_MS, carried: false };
  return answer;
}

function refreshOnce(environment: Environment): Promise<boolean> {
  if (!refreshInFlight) {
    refreshInFlight = refresh(environment).finally(() => {
      refreshInFlight = null;
    });
  }
  return refreshInFlight;
}

/** Whether reports are on. Awaits PostHog (at most 1.5 s) when the cached answer is stale. Never throws. */
export async function isDirectoryReportsEnabled(environment: Environment = process.env): Promise<boolean> {
  const override = readOverride(environment);
  if (override !== undefined) return override;
  if (cachedAnswer && cachedAnswer.expiresAt > Date.now()) return cachedAnswer.enabled;
  return refreshOnce(environment);
}

/**
 * Whether reports are on, from the override or the cached answer, without
 * waiting. Safe inside a transaction. A stale cache starts a refresh in the
 * background and answers with what it has (off when it has nothing).
 */
export function directoryReportsEnabledNow(environment: Environment = process.env): boolean {
  const override = readOverride(environment);
  if (override !== undefined) return override;
  if (!cachedAnswer || cachedAnswer.expiresAt <= Date.now()) {
    void refreshOnce(environment);
  }
  return cachedAnswer?.enabled ?? false;
}

/**
 * Read the first answer (at most 1.5 s) and keep it fresh, so
 * `directoryReportsEnabledNow()` rarely reads a stale one. Boot awaits it before
 * the server and the push worker start: a cold cache reads as off, which would
 * drop the notices and pushes of the first minute.
 */
export async function startDirectoryReportsFlagRefresh(): Promise<() => void> {
  await isDirectoryReportsEnabled();
  const interval = setInterval(() => {
    void isDirectoryReportsEnabled();
  }, DIRECTORY_REPORTS_FLAG_CACHE_MS / 2);
  interval.unref();
  return () => clearInterval(interval);
}

export function __resetDirectoryReportsFlagForTests(): void {
  cachedAnswer = null;
  refreshInFlight = null;
  outageLogged = false;
}
