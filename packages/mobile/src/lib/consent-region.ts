import { createConsentRegionLookup } from '@boardsesh/consent';
import { GET_CONSENT_REGION, type GetConsentRegionResponse } from '@boardsesh/graphql/operations/analytics-consent';
import { getHttpClient } from './graphql/client';

/** Same cap as the signed-in account read: past it, the prompt is shown. */
export const CONSENT_REGION_WAIT_MS = 5000;

let lookup = createConsentRegionLookup(requestConsentRegion);
/** The last answer carried `Sec-GPC: 1` back (browser app only). */
let answeredGlobalPrivacyControl = false;

/**
 * True, false, or null when the backend did not answer within five seconds.
 * A foreground resume expires the answer. If its request is still pending,
 * callers receive only the queued fresh answer after that request settles.
 */
export function lookUpConsentRegion(): Promise<boolean | null> {
  return lookup.lookUp();
}

/** Hold capture on resume and queue one fresh request behind an in-flight lookup. */
export function expireConsentRegionLookup(): boolean {
  return lookup.expire();
}

/** Ignore callbacks from an answer expired before its consumer ran. */
export function isConsentRegionLookupCurrent(answer: Promise<boolean | null>): boolean {
  return lookup.isCurrent(answer);
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
  lookup = createConsentRegionLookup(requestConsentRegion);
  answeredGlobalPrivacyControl = false;
}
