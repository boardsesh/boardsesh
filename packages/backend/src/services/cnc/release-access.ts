import { GraphQLError } from 'graphql';
import { FEATURE_FLAG_OVERRIDES_ENV, parseFeatureFlagOverrides } from '@boardsesh/analytics';

/** The same flag and authenticated/anonymous identities as www's build-plan gate. */
const CNC_PACKS_FLAG = 'cnc-packs';
const ANONYMOUS_DISTINCT_ID = 'anonymous-web-visitor';
const FLAG_TIMEOUT_MS = 1_500;
const FLAG_CACHE_MS = 60_000;
const MAX_CACHE_ENTRIES = 1_000;
const DEFAULT_POSTHOG_HOST = 'https://us.i.posthog.com';
const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);

type FlagAnswer = { enabled: boolean; expiresAt: number };
const answers = new Map<string, FlagAnswer>();
const pending = new Map<string, Promise<boolean>>();

function isRecord(payload: unknown): payload is Record<string, unknown> {
  return typeof payload === 'object' && payload !== null && !Array.isArray(payload);
}

function readAnswer(payload: unknown): boolean | null {
  if (!isRecord(payload)) return null;
  const { flags, featureFlags, errorsWhileComputingFlags, quotaLimited } = payload;
  if (errorsWhileComputingFlags === true) return null;
  const detail = isRecord(flags) ? flags[CNC_PACKS_FLAG] : undefined;
  if (isRecord(detail) && detail.failed === true) return null;
  if (isRecord(detail) && typeof detail.enabled === 'boolean') return detail.enabled;
  const legacy = isRecord(featureFlags) ? featureFlags[CNC_PACKS_FLAG] : undefined;
  if (typeof legacy === 'boolean') return legacy;
  if (typeof legacy === 'string' && legacy.length > 0) return true;
  if (Array.isArray(quotaLimited) && quotaLimited.length > 0) return null;
  return isRecord(flags) || isRecord(featureFlags) ? false : null;
}

function flagsUrl(): URL | null {
  try {
    const host = process.env.POSTHOG_HOST?.trim() || DEFAULT_POSTHOG_HOST;
    const url = new URL(`${host.replace(/\/+$/, '')}/flags/?v=2`);
    if (url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK_HOSTNAMES.has(url.hostname))) return url;
  } catch {
    // Invalid deployment configuration closes new work.
  }
  return null;
}

async function askPosthog(distinctId: string, apiKey: string, url: URL): Promise<boolean | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FLAG_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: apiKey,
        distinct_id: distinctId,
        person_properties: { distinct_id: distinctId },
        flag_keys_to_evaluate: [CNC_PACKS_FLAG],
        geoip_disable: true,
      }),
      redirect: 'error',
      signal: controller.signal,
    });
    return response.ok ? readAnswer(await response.json()) : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * PostHog is the only CNC release switch. Evaluate before new generator work,
 * outside transactions; existing results and downloads never ask this gate.
 * Invalid/unavailable answers fail closed and are not cached as a rollout refusal.
 */
export async function isCncCreationAllowed(userId: string | null): Promise<boolean> {
  if (userId !== null && (!userId || userId.trim() !== userId)) return false;
  const override = parseFeatureFlagOverrides(process.env[FEATURE_FLAG_OVERRIDES_ENV])[CNC_PACKS_FLAG];
  if (override !== undefined) return override;
  const apiKey = process.env.POSTHOG_PROJECT_KEY?.trim() || process.env.NEXT_PUBLIC_POSTHOG_KEY?.trim();
  const url = flagsUrl();
  if (!apiKey || !url) return false;
  const distinctId = userId ?? ANONYMOUS_DISTINCT_ID;
  const cacheKey = JSON.stringify([apiKey, url.href, distinctId]);
  const cached = answers.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.enabled;
  const inFlight = pending.get(cacheKey);
  if (inFlight) return inFlight;
  // A flood of distinct accounts cannot create unbounded concurrent flag requests.
  if (pending.size >= MAX_CACHE_ENTRIES) return false;
  const request = askPosthog(distinctId, apiKey, url)
    .then((enabled) => {
      if (enabled === null) {
        answers.delete(cacheKey);
        return false;
      }
      answers.delete(cacheKey);
      if (answers.size >= MAX_CACHE_ENTRIES) {
        const oldest = answers.keys().next().value;
        if (oldest !== undefined) answers.delete(oldest);
      }
      answers.set(cacheKey, { enabled, expiresAt: Date.now() + FLAG_CACHE_MS });
      return enabled;
    })
    .finally(() => pending.delete(cacheKey));
  pending.set(cacheKey, request);
  return request;
}

export async function requireCncCreationAccess(userId: string | null): Promise<void> {
  if (!(await isCncCreationAllowed(userId))) {
    throw new GraphQLError('The build-pack service is unavailable right now. Try again in a minute.', {
      extensions: { code: 'CNC_WORKER_UNAVAILABLE' },
    });
  }
}

export async function requireCncCheckoutAccess(userId: string): Promise<void> {
  if (!(await isCncCreationAllowed(userId))) {
    throw new GraphQLError('Build-pack generation is unavailable right now. Try again in a minute.', {
      extensions: { code: 'CNC_CHECKOUT_UNAVAILABLE' },
    });
  }
}

export function resetCncReleaseAccessForTests(): void {
  answers.clear();
  pending.clear();
}
