import { createConsentRegionLookup } from '@boardsesh/consent';
import { GET_CONSENT_REGION, type GetConsentRegionResponse } from '@boardsesh/graphql/operations/analytics-consent';
import { createGraphQLHttpClient } from '@/app/lib/graphql/client';
import { isGlobalPrivacyControlEnabled } from '@/app/lib/consent';

/** Past this the banner shows: an answer we never got counts as "ask". */
export const CONSENT_REGION_WAIT_MS = 5000;

export type ConsentRegionAnswer = {
  /** True, false, or null when the backend did not answer in time. Null means show the banner. */
  promptRequired: boolean | null;
  /**
   * Global Privacy Control: `navigator.globalPrivacyControl`, or the `Sec-GPC`
   * header the backend saw (some extensions set only the header). Outside the
   * prompt regions it is a "no": no region default, no banner.
   */
  globalPrivacyControl: boolean;
};

const lookup = createConsentRegionLookup(requestConsentRegion);

/**
 * Whether this visitor's region gets the consent banner, and whether the
 * browser sent Global Privacy Control.
 *
 * Asked from the browser, never decided on the server: list and climb pages are
 * cached at Cloudflare and shared between visitors, so a region baked into the
 * HTML would hand one country's answer to another. The backend reads the
 * country from a trusted Cloudflare hop (see `resolveFlagCountry`). One request
 * per page load, and only while the device has no answer or holds the region
 * default.
 */
export function lookUpConsentRegion(): Promise<ConsentRegionAnswer> {
  return lookup.lookUp();
}

/** Hold capture on resume and queue one fresh request behind an in-flight lookup. */
export function expireConsentRegionLookup(): boolean {
  return lookup.expire();
}

/** Ignore callbacks from an answer expired before its consumer ran. */
export function isConsentRegionLookupCurrent(answer: Promise<ConsentRegionAnswer>): boolean {
  return lookup.isCurrent(answer);
}

async function requestConsentRegion(): Promise<ConsentRegionAnswer> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let headerGlobalPrivacyControl = false;
  const deadline = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve(null);
    }, CONSENT_REGION_WAIT_MS);
  });
  const answer = (async (): Promise<boolean | null> => {
    try {
      // Building the client sits inside the try: `getGraphQLHttpUrl` throws on
      // an unknown host, and that must read as an unknown region (show the
      // banner), never as an unhandled rejection that leaves it hidden.
      const { consentRegion } = await createGraphQLHttpClient().request<GetConsentRegionResponse>({
        document: GET_CONSENT_REGION,
        signal: controller.signal,
      });
      headerGlobalPrivacyControl = consentRegion?.globalPrivacyControl === true;
      return typeof consentRegion?.promptRequired === 'boolean' ? consentRegion.promptRequired : null;
    } catch {
      return null;
    }
  })();
  try {
    const promptRequired = await Promise.race([answer, deadline]);
    return {
      promptRequired,
      globalPrivacyControl: isGlobalPrivacyControlEnabled() || headerGlobalPrivacyControl,
    };
  } finally {
    clearTimeout(timer);
  }
}
