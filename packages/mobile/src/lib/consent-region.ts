import { GET_CONSENT_REGION, type GetConsentRegionResponse } from '@boardsesh/graphql/operations/analytics-consent';
import { getHttpClient } from './graphql/client';

/** Same cap as the signed-in account read: past it, the prompt is shown. */
export const CONSENT_REGION_WAIT_MS = 5000;

/**
 * A backgrounded app keeps its process for days, and the climber can travel in
 * that time. Resuming after this long looks the region up again.
 */
export const CONSENT_REGION_MAX_AGE_MS = 24 * 60 * 60 * 1000;

type RegionLookup = {
  startedAt: number;
  promise: Promise<boolean | null>;
  /** Undefined until the request settles. */
  promptRequired?: boolean | null;
};

let lookup: RegionLookup | null = null;
/** The last answer carried `Sec-GPC: 1` back (browser app only). */
let answeredGlobalPrivacyControl = false;

/**
 * Whether this launch's region gets the analytics prompt: true, false, or null
 * when the backend did not say within {@link CONSENT_REGION_WAIT_MS} (offline,
 * an error, an older backend). Null means ask. One request per launch, plus one
 * per resume once {@link expireConsentRegionLookup} says the answer is stale.
 */
export function lookUpConsentRegion(): Promise<boolean | null> {
  if (!lookup) {
    const started: RegionLookup = { startedAt: Date.now(), promise: Promise.resolve(null) };
    started.promise = requestConsentRegion().then((promptRequired) => {
      started.promptRequired = promptRequired;
      return promptRequired;
    });
    lookup = started;
  }
  return lookup.promise;
}

/**
 * Forget this launch's answer when it is older than {@link CONSENT_REGION_MAX_AGE_MS},
 * or when the lookup failed, so the next {@link lookUpConsentRegion} asks
 * again. True when it did. A lookup still in flight is kept.
 */
export function expireConsentRegionLookup(now: number = Date.now()): boolean {
  if (!lookup || lookup.promptRequired === undefined) return false;
  if (lookup.promptRequired !== null && now - lookup.startedAt < CONSENT_REGION_MAX_AGE_MS) return false;
  lookup = null;
  return true;
}

/**
 * Global Privacy Control, which only a browser sends: the browser app counts
 * it as a "no" outside the prompt regions, the same as the website. Never true
 * in the native app.
 */
export function isGlobalPrivacyControlEnabled(): boolean {
  const browser = typeof navigator === 'undefined' ? undefined : (navigator as { globalPrivacyControl?: unknown });
  return browser?.globalPrivacyControl === true || answeredGlobalPrivacyControl;
}

async function requestConsentRegion(): Promise<boolean | null> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve(null);
    }, CONSENT_REGION_WAIT_MS);
  });
  const answer = (async (): Promise<boolean | null> => {
    try {
      // Building the client sits inside the try: a client that fails to build
      // is an unknown region (ask), never an unhandled rejection.
      const { consentRegion } = await getHttpClient().request<GetConsentRegionResponse>({
        document: GET_CONSENT_REGION,
        signal: controller.signal,
      });
      answeredGlobalPrivacyControl = consentRegion?.globalPrivacyControl === true;
      return typeof consentRegion?.promptRequired === 'boolean' ? consentRegion.promptRequired : null;
    } catch {
      return null;
    }
  })();
  try {
    return await Promise.race([answer, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/** Test seam: forget this launch's answer. */
export function resetConsentRegionLookup(): void {
  lookup = null;
  answeredGlobalPrivacyControl = false;
}
