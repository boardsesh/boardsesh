import { GET_CONSENT_REGION, type GetConsentRegionResponse } from '@boardsesh/graphql/operations/analytics-consent';
import { getHttpClient } from './graphql/client';

/** Same cap as the signed-in account read: past it, the prompt is shown. */
export const CONSENT_REGION_WAIT_MS = 5000;

let lookup: Promise<boolean | null> | null = null;

/**
 * Whether this launch's region gets the analytics prompt: true, false, or null
 * when the backend did not say within {@link CONSENT_REGION_WAIT_MS} (offline,
 * an error, an older backend). Null means ask. One request per launch; a failed
 * lookup is retried on the next launch, never in a loop.
 */
export function lookUpConsentRegion(): Promise<boolean | null> {
  lookup ??= requestConsentRegion();
  return lookup;
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
  const answer = getHttpClient()
    .request<GetConsentRegionResponse>({ document: GET_CONSENT_REGION, signal: controller.signal })
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

/** Test seam: forget this launch's answer. */
export function resetConsentRegionLookup(): void {
  lookup = null;
}
