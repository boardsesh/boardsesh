/**
 * The one place a paid-social destination URL is built. Ad configs never carry
 * a hand-written URL: they carry a source, a campaign code and an ad id, and
 * this helper turns them into the tagged www link described in
 * docs/growth-metrics.md "Paid social URLs".
 */

export type PaidSocialSource = 'reddit' | 'instagram';

export const PAID_SOCIAL_LANDING = 'https://www.boardsesh.com/';
export const PAID_SOCIAL_MEDIUM = 'paid-social';

/** The App Store `ct` token is `<source>-<code>` cut to 30 characters; `instagram-` is the longest prefix. */
export const MAX_CAMPAIGN_CODE_LENGTH = 18;
const CODE_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const MAX_AD_ID_LENGTH = 40;

export interface PaidSocialUrlInput {
  source: PaidSocialSource;
  campaignCode: string;
  /**
   * Always the literal ad name, on both platforms. Meta's {{ad.name}} macro is not used: Instagram-app boosts
   * never expand it, and one literal rule works for boosts and Ads Manager ads alike.
   */
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
  assertAdId(adId);
  // Every value is [a-z0-9-], so nothing needs percent-encoding.
  return `utm_source=${source}&utm_medium=${PAID_SOCIAL_MEDIUM}&utm_campaign=${campaignCode}&utm_content=${adId}`;
}

export function buildPaidSocialUrl(input: PaidSocialUrlInput): string {
  return `${PAID_SOCIAL_LANDING}?${paidSocialUrlTags(input)}`;
}
