/**
 * The one place a paid-social destination URL is built. Ad configs never carry
 * a hand-written URL: they carry a source, a campaign code and an ad id, and
 * this helper turns them into the tagged www link described in
 * docs/growth-metrics.md "Paid social URLs".
 */

export type PaidSocialSource = 'reddit' | 'instagram';

export const PAID_SOCIAL_LANDING = 'https://www.boardsesh.com/';
export const PAID_SOCIAL_MEDIUM = 'paid-social';
/** Meta replaces this macro with the ad's name when it serves the click. */
export const META_AD_NAME_MACRO = '{{ad.name}}';

/** The App Store `ct` token is `<source>-<code>` cut to 30 characters; `instagram-` is the longest prefix. */
export const MAX_CAMPAIGN_CODE_LENGTH = 18;
const CODE_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const MAX_AD_ID_LENGTH = 40;

export interface PaidSocialUrlInput {
  source: PaidSocialSource;
  campaignCode: string;
  /** A literal ad id, or {@link META_AD_NAME_MACRO} for Instagram ads. */
  adId: string;
}

export function assertCampaignCode(campaignCode: string): string {
  if (
    typeof campaignCode !== 'string' ||
    campaignCode.length === 0 ||
    campaignCode.length > MAX_CAMPAIGN_CODE_LENGTH ||
    !CODE_PATTERN.test(campaignCode)
  )
    throw new Error(
      `Campaign code "${String(campaignCode)}" must be 1-${MAX_CAMPAIGN_CODE_LENGTH} characters of [a-z0-9-] (the App Store ct token is capped at 30)`,
    );
  return campaignCode;
}

export function assertAdId(adId: string): string {
  if (typeof adId !== 'string' || adId.length === 0 || adId.length > MAX_AD_ID_LENGTH || !CODE_PATTERN.test(adId))
    throw new Error(`Ad id "${String(adId)}" must be 1-${MAX_AD_ID_LENGTH} characters of [a-z0-9-]`);
  return adId;
}

/** The query string alone, in the fixed order source, medium, campaign, content. */
export function paidSocialUrlTags({ source, campaignCode, adId }: PaidSocialUrlInput): string {
  if (source !== 'reddit' && source !== 'instagram') throw new Error(`Unknown paid-social source "${String(source)}"`);
  assertCampaignCode(campaignCode);
  if (adId === META_AD_NAME_MACRO) {
    if (source !== 'instagram') throw new Error('The {{ad.name}} macro only works on Meta (Instagram) ads');
  } else assertAdId(adId);
  // Every value is [a-z0-9-] or the literal macro, so nothing needs percent-encoding;
  // encoding the macro's braces would stop Meta from substituting it.
  return `utm_source=${source}&utm_medium=${PAID_SOCIAL_MEDIUM}&utm_campaign=${campaignCode}&utm_content=${adId}`;
}

export function buildPaidSocialUrl(input: PaidSocialUrlInput): string {
  return `${PAID_SOCIAL_LANDING}?${paidSocialUrlTags(input)}`;
}
