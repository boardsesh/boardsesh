import { GET_CONSENT_REGION, type GetConsentRegionResponse } from '@boardsesh/graphql/operations/analytics-consent';
import { executeGraphQL } from '@/app/lib/graphql/client';

/** Past this the banner shows: an answer we never got counts as "ask". */
export const CONSENT_REGION_WAIT_MS = 5000;

let lookup: Promise<boolean | null> | null = null;

/**
 * Whether this visitor's region gets the consent banner: true, false, or null
 * when the backend did not answer within {@link CONSENT_REGION_WAIT_MS}. Null
 * means show the banner.
 *
 * Asked from the browser, never decided on the server: list and climb pages are
 * cached at Cloudflare and shared between visitors, so a region baked into the
 * HTML would hand one country's answer to another. The backend reads the
 * country from a trusted Cloudflare hop (see `resolveFlagCountry`). One request
 * per page load, and only while the device has no answer or holds the region
 * default.
 */
export function lookUpConsentRegion(): Promise<boolean | null> {
  lookup ??= requestConsentRegion();
  return lookup;
}

async function requestConsentRegion(): Promise<boolean | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), CONSENT_REGION_WAIT_MS);
  });
  const answer = executeGraphQL<GetConsentRegionResponse>(GET_CONSENT_REGION)
    .then(({ consentRegion }) =>
      typeof consentRegion?.promptRequired === 'boolean' ? consentRegion.promptRequired : null,
    )
    .catch(() => null);
  try {
    return await Promise.race([answer, deadline]);
  } finally {
    clearTimeout(timer);
  }
}
